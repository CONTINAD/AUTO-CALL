import { errorMessage, getJson } from "./http.js";
import type { PumpFunClient } from "./pumpfun.js";

export interface TokenInfo {
  mint: string;
  name: string;
  symbol: string;
  description: string | null;
  twitter: string | null;
  website: string | null;
  telegram: string | null;
  marketCapUsd: number | null;
  /** True once a pump.fun coin has left the bonding curve. */
  graduated: boolean | null;
  source: "pump.fun" | "dexscreener";
}

interface DexPair {
  baseToken: { address: string; name: string; symbol: string };
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  info?: {
    websites?: { label?: string; url: string }[];
    socials?: { type: string; url: string }[];
  };
}

export async function getTokenInfo(mint: string, pump: PumpFunClient): Promise<TokenInfo | null> {
  try {
    const coin = await pump.getCoin(mint);
    if (coin) {
      return {
        mint,
        name: coin.name,
        symbol: coin.symbol,
        description: coin.description || null,
        twitter: coin.twitter || null,
        website: coin.website || null,
        telegram: coin.telegram || null,
        marketCapUsd: coin.usd_market_cap ?? null,
        graduated: coin.complete ?? null,
        source: "pump.fun",
      };
    }
  } catch (err) {
    console.error(`[token] pump.fun lookup failed, trying DexScreener: ${errorMessage(err)}`);
  }

  const pairs = await getJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
  const pair = (pairs ?? [])
    .filter((p) => p.baseToken.address === mint)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  if (!pair) return null;
  const social = (type: string) => pair.info?.socials?.find((s) => s.type === type)?.url ?? null;
  return {
    mint,
    name: pair.baseToken.name,
    symbol: pair.baseToken.symbol,
    description: null,
    twitter: social("twitter"),
    website: pair.info?.websites?.[0]?.url ?? null,
    telegram: social("telegram"),
    marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
    graduated: null,
    source: "dexscreener",
  };
}
