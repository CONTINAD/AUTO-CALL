import Anthropic from "@anthropic-ai/sdk";
import { BuyWatcher, SolanaRpc } from "./buys.js";
import { Caller } from "./caller.js";
import { loadConfig, loadDotEnv } from "./config.js";
import { errorMessage } from "./http.js";
import { PumpFunClient } from "./pumpfun.js";

const USAGE = `Usage:
  npm start                 log into pump.fun and post a call every time your wallet buys
  npm run check -- <MINT>   research and summarize one coin right now (no buy needed)`;

async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const mintAt = args.indexOf("--mint");
  const testMint = mintAt >= 0 ? args[mintAt + 1] : undefined;
  if (args.includes("--help") || (mintAt >= 0 && !testMint)) {
    console.log(USAGE);
    return;
  }

  const config = loadConfig();
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error("⚠️  ANTHROPIC_API_KEY is not set in .env, so calls will go out without a summary.");
  }
  const pump = new PumpFunClient(config.wallet);
  if (config.wallet) {
    try {
      await pump.login();
      const username = await pump.getUsername().catch(() => null);
      console.log(`✅ Logged into pump.fun as ${username ? `@${username} ` : ""}(${config.wallet.address})`);
    } catch (err) {
      // Buy detection is on-chain and doesn't need the session, so keep going.
      console.error(`⚠️  pump.fun login didn't work (${errorMessage(err)}). Continuing without a session.`);
    }
  }

  const caller = new Caller({ pump, anthropic: new Anthropic(), model: config.model, telegram: config.telegram });

  if (testMint) {
    await caller.announce(testMint, null);
    return;
  }
  if (!config.wallet) throw new Error(`PRIVATE_KEY is not set in .env\n\n${USAGE}`);

  console.log(`👀 Watching ${config.wallet.address} for buys${config.telegram ? " (posting to Telegram)" : ""}…`);
  const watcher = new BuyWatcher(new SolanaRpc(config.rpcUrl), config.wallet.address, config.pollIntervalMs);
  await watcher.run((buy) => {
    caller.announce(buy.mint, buy).catch((err) => console.error(`[call] ${errorMessage(err)}`));
  });
}

main().catch((err) => {
  console.error(`❌ ${errorMessage(err)}`);
  process.exit(1);
});
