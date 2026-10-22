import type Anthropic from "@anthropic-ai/sdk";
import type { ParsedTransaction } from "../src/buys.js";

export interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

type Route = (req: Recorded) => Response | Promise<Response>;

/** Replaces global fetch with a router keyed by URL prefix. Returns the request log and a restore fn. */
export function mockFetch(routes: Record<string, Route>) {
  const original = globalThis.fetch;
  const requests: Recorded[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const req: Recorded = {
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    };
    requests.push(req);
    const prefix = Object.keys(routes)
      .filter((p) => url.startsWith(p))
      .sort((a, b) => b.length - a.length)[0];
    if (!prefix) throw new TypeError(`fetch failed (no mock for ${url})`);
    return routes[prefix]!(req);
  }) as typeof fetch;
  return { requests, restore: () => void (globalThis.fetch = original) };
}

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { "content-type": "application/json", ...init.headers } });

/** A stand-in for the Anthropic client that records requests and replies with `reply`. */
export function fakeAnthropic(reply: (params: Anthropic.Beta.MessageCreateParams) => unknown) {
  const calls: Anthropic.Beta.MessageCreateParams[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Anthropic.Beta.MessageCreateParams) => {
          calls.push(params);
          return reply(params);
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

export const textReply = (text: string) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text }],
});

interface TxOptions {
  wallet: string;
  lamports: [number, number];
  fee?: number;
  feePayer?: boolean;
  pre?: { mint: string; amount: string; decimals: number; owner?: string }[];
  post?: { mint: string; amount: string; decimals: number; owner?: string }[];
  err?: unknown;
}

/** Builds a jsonParsed getTransaction result with just the fields detectBuys reads. */
export function makeTx(o: TxOptions): ParsedTransaction {
  const keys = o.feePayer === false ? ["Payer1111", o.wallet] : [o.wallet, "Pool1111"];
  const walletAt = keys.indexOf(o.wallet);
  const pre = [0, 0];
  const post = [0, 0];
  pre[walletAt] = o.lamports[0];
  post[walletAt] = o.lamports[1];
  const balances = (list: TxOptions["pre"]) =>
    (list ?? []).map((b, i) => ({
      accountIndex: 2 + i,
      mint: b.mint,
      owner: b.owner ?? o.wallet,
      uiTokenAmount: { amount: b.amount, decimals: b.decimals },
    }));
  return {
    blockTime: 1_760_000_000,
    meta: {
      err: o.err ?? null,
      fee: o.fee ?? 5000,
      preBalances: pre,
      postBalances: post,
      preTokenBalances: balances(o.pre),
      postTokenBalances: balances(o.post),
    },
    transaction: {
      signatures: ["Sig1111"],
      message: { accountKeys: keys.map((pubkey) => ({ pubkey })) },
    },
  };
}
