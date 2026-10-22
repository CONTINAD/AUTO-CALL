import { existsSync } from "node:fs";
import bs58 from "bs58";
import nacl from "tweetnacl";

export interface Wallet {
  /** Base58 public key. */
  address: string;
  /** 64-byte ed25519 secret key (seed + public key). Never log this. */
  secretKey: Uint8Array;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export interface Config {
  wallet: Wallet | null;
  rpcUrl: string;
  pollIntervalMs: number;
  model: string;
  telegram: TelegramConfig | null;
}

/**
 * Accepts the formats wallets export: a base58 string (Phantom, Solflare,
 * Backpack) or a JSON byte array (solana-keygen keypair files). Both 64-byte
 * secret keys and 32-byte seeds are supported.
 */
export function parsePrivateKey(raw: string): Wallet {
  const input = raw.trim();
  let bytes: Uint8Array;
  if (input.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new Error("PRIVATE_KEY looks like a JSON array but isn't valid JSON");
    }
    if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error("PRIVATE_KEY JSON must be an array of bytes (0-255)");
    }
    bytes = Uint8Array.from(parsed);
  } else {
    try {
      bytes = bs58.decode(input);
    } catch {
      throw new Error("PRIVATE_KEY is not valid base58");
    }
  }

  if (bytes.length !== 32 && bytes.length !== 64) {
    throw new Error(`PRIVATE_KEY decodes to ${bytes.length} bytes; expected 64 (secret key) or 32 (seed)`);
  }
  const keypair = nacl.sign.keyPair.fromSeed(bytes.slice(0, 32));
  if (bytes.length === 64 && !bytes.slice(32).every((b, i) => b === keypair.publicKey[i])) {
    throw new Error("PRIVATE_KEY is corrupted: its public half doesn't match its seed");
  }
  return { address: bs58.encode(keypair.publicKey), secretKey: keypair.secretKey };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const privateKey = env.PRIVATE_KEY?.trim();
  const pollIntervalMs = Number(env.POLL_INTERVAL_MS ?? 3000);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 500) {
    throw new Error("POLL_INTERVAL_MS must be a number >= 500");
  }

  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (Boolean(botToken) !== Boolean(chatId)) {
    throw new Error("Set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, or neither");
  }

  return {
    wallet: privateKey ? parsePrivateKey(privateKey) : null,
    rpcUrl: env.SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com",
    pollIntervalMs,
    model: env.CLAUDE_MODEL?.trim() || "claude-opus-5-5",
    telegram: botToken && chatId ? { botToken, chatId } : null,
  };
}

export function loadDotEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
