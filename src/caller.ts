import type Anthropic from "@anthropic-ai/sdk";
import type { Buy } from "./buys.js";
import type { TelegramConfig } from "./config.js";
import { describeHttpError, errorMessage } from "./http.js";
import type { PumpFunClient } from "./pumpfun.js";
import { summarize } from "./summarize.js";
import { getTokenInfo, type TokenInfo } from "./token.js";
import { fetchTwitterContext, pickTwitterLink, type TwitterLink } from "./twitter.js";

export interface Call {
  mint: string;
  token: TokenInfo | null;
  link: TwitterLink | null;
  /** Null when Claude couldn't be reached; `error` says why. */
  summary: string | null;
  error?: string;
}

export interface CallerDeps {
  pump: PumpFunClient;
  anthropic: Anthropic;
  model: string;
  telegram: TelegramConfig | null;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 });

export function formatCall(call: Call, buy: Buy | null, repeat: boolean): string {
  const t = call.token;
  const title = t ? `$${t.symbol} — ${t.name}` : call.mint;
  const heading = buy ? `🟢 ${repeat ? "ADDED" : "BUY"} ${title}` : `🔎 ${title}`;

  const trade = buy
    ? [
        buy.solSpent > 0 && `${buy.solSpent.toFixed(buy.solSpent < 1 ? 3 : 2)} SOL`,
        buy.usdSpent > 0 && `$${buy.usdSpent.toFixed(2)}`,
      ].filter(Boolean).join(" + ") + ` → ${compact.format(buy.tokenAmount)} tokens`
    : null;
  const mc = t?.marketCapUsd != null ? `MC $${compact.format(t.marketCapUsd)}` : null;
  const stats = [trade, mc].filter(Boolean).join(" · ");

  return [
    heading,
    stats && `💰 ${stats}`,
    `🧠 ${call.summary ?? `(no summary: ${call.error ?? "unknown error"})`}`,
    call.link && `🐦 ${call.link.url}`,
    `📈 https://pump.fun/coin/${call.mint}`,
    `CA: ${call.mint}`,
  ].filter(Boolean).join("\n");
}

export async function sendTelegram(cfg: TelegramConfig, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.chatId, text, link_preview_options: { is_disabled: true } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Telegram: ${await describeHttpError(res)}`);
}

/** Turns buys into calls. Each coin is researched and summarized once; re-buys reuse it. */
export class Caller {
  private readonly calls = new Map<string, Promise<Call>>();

  constructor(private readonly deps: CallerDeps) {}

  async announce(mint: string, buy: Buy | null): Promise<string> {
    const repeat = this.calls.has(mint);
    const call = await this.getCall(mint);
    const message = formatCall(call, buy, repeat);
    console.log(`\n${message}\n`);
    if (this.deps.telegram) {
      await sendTelegram(this.deps.telegram, message).catch((err) =>
        console.error(`[telegram] ${errorMessage(err)}`),
      );
    }
    return message;
  }

  private getCall(mint: string): Promise<Call> {
    let call = this.calls.get(mint);
    if (!call) {
      call = this.buildCall(mint);
      this.calls.set(mint, call);
      // Don't cache a failed summary; the next buy of this coin tries again.
      void call.then(
        (c) => {
          if (!c.summary) this.calls.delete(mint);
        },
        () => this.calls.delete(mint),
      );
    }
    return call;
  }

  private async buildCall(mint: string): Promise<Call> {
    const { pump, anthropic, model } = this.deps;
    const token = await getTokenInfo(mint, pump).catch((err) => {
      console.error(`[token] lookup failed for ${mint}: ${errorMessage(err)}`);
      return null;
    });
    const link = token ? pickTwitterLink(token) : null;
    const twitter = link
      ? await fetchTwitterContext(link).catch((err) => {
          console.error(`[twitter] couldn't read ${link.url}: ${errorMessage(err)}`);
          return null;
        })
      : null;

    try {
      const summary = await summarize(anthropic, model, { mint, token, twitter });
      return { mint, token, link, summary };
    } catch (err) {
      console.error(`[claude] summary failed for ${mint}: ${errorMessage(err)}`);
      return { mint, token, link, summary: null, error: errorMessage(err) };
    }
  }
}
