import assert from "node:assert/strict";
import { test } from "node:test";
import { BuyWatcher, detectBuys, type ParsedTransaction, type SolanaRpc } from "../src/buys.js";
import { makeTx } from "./helpers.js";

const W = "Wallet1111111111111111111111111111111111111";
const MEME = "Meme111111111111111111111111111111111111pump";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

test("pump.fun buy: SOL out, new token account in", () => {
  const tx = makeTx({
    wallet: W,
    lamports: [2_000_000_000, 1_497_955_000], // 0.5 SOL + 5000 fee + rent
    post: [{ mint: MEME, amount: "35000000000000", decimals: 6 }],
  });
  const [buy, ...rest] = detectBuys(tx, W);
  assert.equal(rest.length, 0);
  assert.equal(buy!.mint, MEME);
  assert.equal(buy!.tokenAmount, 35_000_000);
  assert.ok(Math.abs(buy!.solSpent - 0.50204) < 1e-9);
  assert.equal(buy!.signature, "Sig1111");
});

test("adding to an existing position counts the increase only", () => {
  const tx = makeTx({
    wallet: W,
    lamports: [1_000_000_000, 899_995_000],
    pre: [{ mint: MEME, amount: "1000000", decimals: 6 }],
    post: [{ mint: MEME, amount: "3000000", decimals: 6 }],
  });
  assert.equal(detectBuys(tx, W)[0]!.tokenAmount, 2);
});

test("sells, incoming transfers, failed txs and fee-only txs are not buys", () => {
  const sell = makeTx({
    wallet: W,
    lamports: [1_000_000_000, 1_400_000_000],
    pre: [{ mint: MEME, amount: "5000000", decimals: 6 }],
    post: [{ mint: MEME, amount: "0", decimals: 6 }],
  });
  const airdrop = makeTx({
    wallet: W,
    feePayer: false,
    lamports: [1_000_000_000, 1_000_000_000],
    post: [{ mint: MEME, amount: "5000000", decimals: 6 }],
  });
  const failed = makeTx({
    wallet: W,
    lamports: [1_000_000_000, 499_995_000],
    post: [{ mint: MEME, amount: "5000000", decimals: 6 }],
    err: { InstructionError: [2, { Custom: 6001 }] },
  });
  const feeOnly = makeTx({
    wallet: W,
    lamports: [1_000_000_000, 999_995_000],
    post: [{ mint: MEME, amount: "5000000", decimals: 6 }],
  });
  for (const tx of [sell, airdrop, failed, feeOnly]) assert.deepEqual(detectBuys(tx, W), []);
  assert.deepEqual(detectBuys({ ...sell, meta: null } as ParsedTransaction, W), []);
});

test("another owner's token accounts are ignored", () => {
  const tx = makeTx({
    wallet: W,
    lamports: [1_000_000_000, 500_000_000],
    post: [{ mint: MEME, amount: "5000000", decimals: 6, owner: "SomeoneElse111" }],
  });
  assert.deepEqual(detectBuys(tx, W), []);
});

test("buys paid from a wSOL balance are counted; wrapping alone is not", () => {
  const fromWsol = makeTx({
    wallet: W,
    lamports: [1_000_000_000, 999_995_000],
    pre: [{ mint: WSOL, amount: "300000000", decimals: 9 }],
    post: [
      { mint: WSOL, amount: "0", decimals: 9 },
      { mint: MEME, amount: "42", decimals: 0 },
    ],
  });
  const buy = detectBuys(fromWsol, W)[0]!;
  assert.equal(buy.mint, MEME);
  assert.ok(Math.abs(buy.solSpent - 0.3) < 1e-9);

  const wrapOnly = makeTx({
    wallet: W,
    lamports: [1_000_000_000, 699_995_000],
    post: [{ mint: WSOL, amount: "300000000", decimals: 9 }],
  });
  assert.deepEqual(detectBuys(wrapOnly, W), []);
});

test("buys paid in USDC are counted", () => {
  const tx = makeTx({
    wallet: W,
    lamports: [1_000_000_000, 999_995_000],
    pre: [{ mint: USDC, amount: "50000000", decimals: 6 }],
    post: [
      { mint: USDC, amount: "0", decimals: 6 },
      { mint: MEME, amount: "1000000", decimals: 6 },
    ],
  });
  const buy = detectBuys(tx, W)[0]!;
  assert.equal(buy.usdSpent, 50);
  assert.equal(buy.solSpent, 0);
});

test("watcher skips history, reports new buys once, and retries unindexed txs", async () => {
  const buyTx = (sig: string) => {
    const tx = makeTx({ wallet: W, lamports: [2e9, 1e9], post: [{ mint: MEME, amount: "1", decimals: 0 }] });
    tx.transaction.signatures = [sig];
    return tx;
  };
  // Newest first, like getSignaturesForAddress.
  let history: { signature: string; err: unknown }[] = [{ signature: "old", err: null }];
  const fetches: string[] = [];
  const rpc = {
    getSignatures: async (_: string, opts: { until?: string }) => {
      const stop = history.findIndex((s) => s.signature === opts.until);
      return stop === -1 ? history : history.slice(0, stop);
    },
    getTransaction: async (sig: string) => {
      fetches.push(sig);
      // b2 isn't indexed the first time it's asked for.
      if (sig === "b2" && fetches.filter((s) => s === "b2").length === 1) return null;
      return buyTx(sig);
    },
  } as unknown as SolanaRpc;

  const seen: string[] = [];
  const controller = new AbortController();
  const watcher = new BuyWatcher(rpc, W, 1, 0);
  const run = watcher.run((b) => seen.push(b.signature), controller.signal);

  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(fetches, [], "existing history isn't replayed");
  history = [{ signature: "b2", err: null }, { signature: "failed", err: { x: 1 } }, { signature: "b1", err: null }, ...history];
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();
  await run;
  assert.deepEqual(seen, ["b1", "b2"], "each buy reported once, in order");
  assert.deepEqual(fetches, ["b1", "b2", "b2"], "failed tx never fetched; unindexed b2 retried once");
});

test("watcher gives up on a transaction the RPC never serves", async () => {
  let history: { signature: string; err: unknown }[] = [];
  const rpc = {
    getSignatures: async (_: string, opts: { until?: string }) => {
      const stop = history.findIndex((s) => s.signature === opts.until);
      return stop === -1 ? history : history.slice(0, stop);
    },
    getTransaction: async () => null,
  } as unknown as SolanaRpc;
  const watcher = new BuyWatcher(rpc, W, 1, 0);
  const controller = new AbortController();
  const { error } = console;
  const logged: string[] = [];
  console.error = (msg: string) => logged.push(msg);
  try {
    const run = watcher.run(() => {}, controller.signal);
    await new Promise((r) => setTimeout(r, 10));
    history = [{ signature: "ghost", err: null }];
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await run;
  } finally {
    console.error = error;
  }
  assert.equal(logged.filter((m) => m.includes("will retry")).length, 2);
  assert.equal(logged.filter((m) => m.includes("giving up on transaction ghost")).length, 1);
});
