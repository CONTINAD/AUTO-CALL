import bs58 from "bs58";
import nacl from "tweetnacl";
import type { Wallet } from "./config.js";
import { describeHttpError } from "./http.js";

const API = "https://frontend-api-v3.pump.fun";

// pump.fun's API rejects requests that don't look like they come from its own site.
const SITE_HEADERS = {
  accept: "application/json",
  origin: "https://pump.fun",
  referer: "https://pump.fun/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

/** Coin fields from GET /coins/{mint}. Only the ones we use are listed. */
export interface PumpCoin {
  mint: string;
  name: string;
  symbol: string;
  description: string | null;
  image_uri: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  usd_market_cap: number | null;
  complete: boolean;
}

export interface LoginPayload {
  address: string;
  signature: string;
  timestamp: number;
}

/**
 * Same message the pump.fun site asks Phantom to sign. Signing it proves you
 * own the wallet; it is not a transaction and can't move funds.
 */
export function buildLoginPayload(wallet: Wallet, timestamp = Date.now()): LoginPayload {
  const message = new TextEncoder().encode(`Sign in to pump.fun: ${timestamp}`);
  const signature = nacl.sign.detached(message, wallet.secretKey);
  return { address: wallet.address, signature: bs58.encode(signature), timestamp };
}

export function extractAuthToken(setCookieHeaders: string[]): string | null {
  for (const header of setCookieHeaders) {
    const match = /^\s*auth_token=([^;]+)/.exec(header);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

/** Reads the `exp` claim (unix seconds) from a JWT without verifying it. */
export function jwtExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

export class PumpFunClient {
  private authToken: string | null = null;
  private expiresAt: number | null = null;

  /** Without a wallet the client can still read public coin data. */
  constructor(private readonly wallet: Wallet | null) {}

  /** Logs in with a signed message and stores the session token. */
  async login(): Promise<void> {
    if (!this.wallet) throw new Error("pump.fun login needs PRIVATE_KEY");
    const res = await fetch(`${API}/auth/login`, {
      method: "POST",
      headers: { ...SITE_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(buildLoginPayload(this.wallet)),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`login rejected: ${await describeHttpError(res)}`);

    const token = extractAuthToken(res.headers.getSetCookie());
    if (!token) throw new Error("login returned no auth_token cookie");
    this.authToken = token;
    this.expiresAt = jwtExpiry(token);
  }

  /** The logged-in account's pump.fun username, if it has one. */
  async getUsername(): Promise<string | null> {
    if (!this.wallet) return null;
    const res = await this.request(`/users/${this.wallet.address}`);
    if (!res.ok) return null;
    const user = (await res.json()) as { username?: string | null };
    return user.username || null;
  }

  /** Returns null if pump.fun doesn't know the mint (e.g. not a pump.fun coin). */
  async getCoin(mint: string): Promise<PumpCoin | null> {
    const res = await this.request(`/coins/${mint}?sync=true`);
    if (res.status === 404 || res.status === 204) return null;
    if (!res.ok) throw new Error(`pump.fun /coins failed: ${await describeHttpError(res)}`);
    const text = await res.text();
    return text ? (JSON.parse(text) as PumpCoin) : null;
  }

  private async request(path: string, retried = false): Promise<Response> {
    // Refresh the session a few minutes before the JWT expires.
    if (this.expiresAt && Date.now() / 1000 > this.expiresAt - 300) await this.login();

    const headers: Record<string, string> = { ...SITE_HEADERS };
    if (this.authToken) {
      headers.cookie = `auth_token=${this.authToken}`;
      headers.authorization = `Bearer ${this.authToken}`;
    }
    const res = await fetch(`${API}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
    if ((res.status === 401 || res.status === 403) && this.wallet && !retried) {
      await this.login();
      return this.request(path, true);
    }
    return res;
  }
}
