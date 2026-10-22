import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Buy } from "../src/buys.js";
import { Caller, formatCall } from "../src/caller.js";
import { PumpFunClient } from "../src/pumpfun.js";
import { fakeAnthropic, json, mockFetch, textReply } from "./helpers.js";

const MINT = "Meme111111111111111111111111111111111111pump";
const buy: Buy = { signature: "s", mint: MINT, tokenAmount: 35_000_000, solSpent: 0.502, usdSpent: 0, blockTime: null };
let restore = () => {};
afterEach(() => restore());

const quiet = <T>(fn: () => Promise<T>) => async () => {
  const { log, error } = console;
  console.log = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, error });
  }
};

test(
  "buy → pump.fun coin → tweet → Claude → console + Telegram, summarized once per coin",
  quiet(async () => {
    const mock = mockFetch({
      "https://frontend-api-v3.pump.fun/coins/": () =>
        json({
          mint: MINT,
          name: "Frog Coin",
          symbol: "FROG",
          description: "ribbit",
          twitter: null,
          website: "https://x.com/frog/status/42",
          usd_market_cap: 45_300,
          complete: false,
        }),
      "https://api.fxtwitter.com/2/status/42": () =>
        json({
          status: {
            type: "status",
            url: "https://x.com/frog/status/42",
            text: "the frog has landed",
            created_at: "",
            likes: 1,
            reposts: 1,
            author: { name: "Frog", screen_name: "frog", description: "", followers: 10 },
          },
        }),
      "https://api.telegram.org/botT0K/sendMessage": () => json({ ok: true }),
    });
    restore = mock.restore;
    const claude = fakeAnthropic(() => textReply("Frog Coin is the frog that landed, per its launch tweet."));
    const caller = new Caller({
      pump: new PumpFunClient(null),
      anthropic: claude.client,
      model: "claude-opus-5-5",
      telegram: { botToken: "T0K", chatId: "-100" },
    });

    const first = await caller.announce(MINT, buy);
    assert.equal(
      first,
      [
        "🟢 BUY $FROG — Frog Coin",
        "💰 0.502 SOL → 35M tokens · MC $45.3K",
        "🧠 Frog Coin is the frog that landed, per its launch tweet.",
        "🐦 https://x.com/i/status/42",
        `📈 https://pump.fun/coin/${MINT}`,
        `CA: ${MINT}`,
      ].join("\n"),
    );
    const second = await caller.announce(MINT, buy);
    assert.match(second, /^🟢 ADDED \$FROG/);
    assert.equal(claude.calls.length, 1, "re-buy reuses the summary");

    const sent = mock.requests.filter((r) => r.url.includes("api.telegram.org"));
    assert.equal(sent.length, 2);
    assert.deepEqual(JSON.parse(sent[0]!.body!), {
      chat_id: "-100",
      text: first,
      link_preview_options: { is_disabled: true },
    });
  }),
);

test(
  "falls back to DexScreener, and retries Claude on the next buy after a failure",
  quiet(async () => {
    restore = mockFetch({
      "https://frontend-api-v3.pump.fun/coins/": () => new Response("cf challenge", { status: 403 }),
      "https://api.dexscreener.com/tokens/v1/solana/": () =>
        json([
          { baseToken: { address: MINT, name: "Thin", symbol: "THIN" }, liquidity: { usd: 1 } },
          {
            baseToken: { address: MINT, name: "Frog Coin", symbol: "FROG" },
            liquidity: { usd: 9000 },
            marketCap: 1_000_000,
            info: { socials: [{ type: "twitter", url: "https://x.com/i/communities/77" }] },
          },
        ]),
    }).restore;
    let fail = true;
    const claude = fakeAnthropic(() => {
      if (fail) throw new Error("overloaded");
      return textReply("Frog Coin has an X community.");
    });
    const caller = new Caller({ pump: new PumpFunClient(null), anthropic: claude.client, model: "m", telegram: null });

    const first = await caller.announce(MINT, buy);
    assert.match(first, /^🟢 BUY \$FROG — Frog Coin/);
    assert.match(first, /🧠 \(no summary: overloaded\)/);
    assert.match(first, /🐦 https:\/\/x\.com\/i\/communities\/77/);

    fail = false;
    const second = await caller.announce(MINT, buy);
    assert.match(second, /🧠 Frog Coin has an X community\./);
    assert.equal(claude.calls.length, 2);
  }),
);

test("check mode (no buy) formats without trade stats", () => {
  const msg = formatCall({ mint: MINT, token: null, link: null, summary: "x" }, null, false);
  assert.equal(msg, [`🔎 ${MINT}`, "🧠 x", `📈 https://pump.fun/coin/${MINT}`, `CA: ${MINT}`].join("\n"));
});
