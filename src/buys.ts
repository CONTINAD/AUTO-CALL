import { describeHttpError, errorMessage } from "./http.js";

const WSOL = "So11111111111111111111111111111111111111112";
const STABLES = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export interface Buy {
  signature: string;
  mint: string;
  /** Tokens received, in UI units. */
  tokenAmount: number;
  /** SOL spent, excluding the network fee (includes priority tips, platform fees, rent). */
  solSpent: number;
  /** USDC/USDT spent, for buys routed through a stablecoin. */
  usdSpent: number;
  blockTime: number | null;
}

// Minimal shapes of the Solana JSON-RPC responses we read (encoding: "jsonParsed").
interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface ParsedTransaction {
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: { pubkey: string }[] };
  };
}

interface SignatureInfo {
  signature: string;
  err: unknown;
}

/**
 * Finds the tokens `wallet` bought in a transaction: any token whose balance
 * went up while SOL (or a stablecoin) went down. This works for any venue
 * (pump.fun, PumpSwap, Jupiter, Raydium, trading bots) because it only looks
 * at the wallet's balance changes, not at which program was called.
 */
export function detectBuys(tx: ParsedTransaction, wallet: string): Buy[] {
  const meta = tx.meta;
  if (!meta || meta.err) return [];

  const deltas = new Map<string, { raw: bigint; decimals: number }>();
  const apply = (balances: TokenBalance[] | undefined, sign: bigint) => {
    for (const b of balances ?? []) {
      if (b.owner !== wallet) continue;
      const d = deltas.get(b.mint) ?? { raw: 0n, decimals: b.uiTokenAmount.decimals };
      d.raw += sign * BigInt(b.uiTokenAmount.amount);
      deltas.set(b.mint, d);
    }
  };
  apply(meta.preTokenBalances, -1n);
  apply(meta.postTokenBalances, 1n);

  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const walletIndex = keys.indexOf(wallet);
  const lamportDelta = walletIndex >= 0 ? meta.postBalances[walletIndex]! - meta.preBalances[walletIndex]! : 0;
  const feePaid = walletIndex === 0 ? meta.fee : 0;
  // Net out wrapped SOL so wrapping/unwrapping in the same tx isn't counted as spending.
  const wsolDelta = Number(deltas.get(WSOL)?.raw ?? 0n);
  const solSpent = (-lamportDelta - wsolDelta - feePaid) / 1e9;

  let usdSpent = 0;
  for (const [mint, d] of deltas) {
    if (STABLES.has(mint) && d.raw < 0n) usdSpent += toUi(-d.raw, d.decimals);
  }
  if (solSpent <= 0 && usdSpent <= 0) return [];

  const buys: Buy[] = [];
  for (const [mint, d] of deltas) {
    if (mint === WSOL || STABLES.has(mint) || d.raw <= 0n) continue;
    buys.push({
      signature: tx.transaction.signatures[0]!,
      mint,
      tokenAmount: toUi(d.raw, d.decimals),
      solSpent: Math.max(solSpent, 0),
      usdSpent,
      blockTime: tx.blockTime,
    });
  }
  return buys;
}

function toUi(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export class SolanaRpc {
  constructor(private readonly url: string) {}

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`RPC ${method}: ${await describeHttpError(res)}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message} (${body.error.code})`);
    return body.result as T;
  }

  getSignatures(address: string, opts: { until?: string; before?: string; limit: number }) {
    return this.call<SignatureInfo[]>("getSignaturesForAddress", [address, { ...opts, commitment: "confirmed" }]);
  }

  getTransaction(signature: string) {
    return this.call<ParsedTransaction | null>("getTransaction", [
      signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    ]);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls the wallet's transaction history and reports each new buy. Polling
 * (instead of a websocket) means nothing is missed after a dropped
 * connection: every poll picks up from the last signature it saw.
 */
export class BuyWatcher {
  private cursor: string | undefined;
  private readonly seen = new Set<string>();
  private readonly misses = new Map<string, number>();

  constructor(
    private readonly rpc: SolanaRpc,
    private readonly wallet: string,
    private readonly intervalMs: number,
    private readonly txRetryDelayMs = 750,
  ) {}

  async run(onBuy: (buy: Buy) => void, signal?: AbortSignal): Promise<void> {
    // Start from the wallet's latest transaction so old buys aren't replayed.
    while (!signal?.aborted) {
      try {
        const [latest] = await this.rpc.getSignatures(this.wallet, { limit: 1 });
        this.cursor = latest?.signature;
        break;
      } catch (err) {
        console.error(`[rpc] couldn't read wallet history, retrying: ${errorMessage(err)}`);
        await sleep(this.intervalMs * 2);
      }
    }

    let failures = 0;
    while (!signal?.aborted) {
      try {
        await this.poll(onBuy);
        failures = 0;
      } catch (err) {
        failures++;
        console.error(`[rpc] poll failed: ${errorMessage(err)}`);
      }
      // Back off up to 30s while the RPC is failing or rate-limiting us.
      await sleep(Math.min(this.intervalMs * 2 ** failures, 30_000));
    }
  }

  private async poll(onBuy: (buy: Buy) => void): Promise<void> {
    // Newest first; page back until we reach the cursor.
    const fresh: SignatureInfo[] = [];
    let before: string | undefined;
    for (let page = 0; page < 5; page++) {
      const batch = await this.rpc.getSignatures(this.wallet, { until: this.cursor, before, limit: 100 });
      fresh.push(...batch);
      if (batch.length < 100) break;
      before = batch.at(-1)!.signature;
    }
    if (fresh.length === 0) return;

    // Oldest first. The cursor only advances past transactions we've handled,
    // so one the RPC can't serve yet is retried on the next poll.
    for (const sig of fresh.reverse()) {
      if (!sig.err && !this.seen.has(sig.signature)) {
        const tx = await this.fetchTransaction(sig.signature);
        if (!tx) {
          const misses = (this.misses.get(sig.signature) ?? 0) + 1;
          this.misses.set(sig.signature, misses);
          if (misses < 3) {
            console.error(`[rpc] transaction ${sig.signature} not available yet, will retry`);
            return;
          }
          console.error(`[rpc] giving up on transaction ${sig.signature}`);
        } else {
          for (const buy of detectBuys(tx, this.wallet)) onBuy(buy);
        }
        this.seen.add(sig.signature);
        this.misses.delete(sig.signature);
      }
      this.cursor = sig.signature;
    }
    if (this.seen.size > 5000) this.seen.clear();
  }

  private async fetchTransaction(signature: string): Promise<ParsedTransaction | null> {
    // Freshly confirmed transactions can briefly return null.
    for (let attempt = 0; attempt < 4; attempt++) {
      const tx = await this.rpc.getTransaction(signature);
      if (tx) return tx;
      await sleep(this.txRetryDelayMs * (attempt + 1));
    }
    return null;
  }
}
