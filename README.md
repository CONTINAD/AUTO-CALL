# AUTO-CALL

Logs into your pump.fun account with your wallet's private key, watches the wallet for buys, and for every coin you buy reads its X (Twitter) post and writes one sentence on what the coin is and why it's bullish.

```
✅ Logged into pump.fun as @yourname (7xKX…9fQp)
👀 Watching 7xKX…9fQp for buys…

🟢 BUY $FROG — Frog Coin
💰 0.502 SOL → 35M tokens · MC $45.3K
🧠 Frog Coin is the first frog on the moon, launched by a 54K-follower meme account whose reveal post is already at 90K views.
🐦 https://x.com/i/status/1850000000000000001
📈 https://pump.fun/coin/Meme…pump
CA: Meme…pump
```

## Setup

Requires Node.js 20.12 or newer.

```bash
npm install
cp .env.example .env     # then fill in PRIVATE_KEY and ANTHROPIC_API_KEY
```

Try it on any coin before trusting it with a live wallet (no buy needed, and no private key required):

```bash
npm run check -- <MINT_ADDRESS>
```

Then run it:

```bash
npm start
```

Leave it running. Every buy from that wallet gets a call printed in the terminal, and posted to Telegram if `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set.

## How it works

1. **Login.** Signs pump.fun's `Sign in to pump.fun: <timestamp>` message with your key, the same thing Phantom does when you connect on the site, and keeps the session cookie. The session is renewed automatically before it expires.
2. **Buy detection.** Polls the wallet's transactions over Solana RPC and flags any transaction where a token balance went up while SOL (or USDC/USDT) went down. It works no matter where you buy: pump.fun, PumpSwap, Axiom, Photon, Jupiter or a trading bot. Sells, incoming transfers and failed transactions are ignored, and old history isn't replayed on startup.
3. **Coin lookup.** Pulls name, description and socials from pump.fun, falling back to DexScreener for coins pump.fun doesn't have.
4. **Tweet scan.** Finds the coin's X link (a specific post beats a profile; the twitter field, website and description are all checked) and reads it through FxTwitter, falling back to X's public embed endpoint. For a profile link it reads the bio and the latest posts. No X API key is needed.
5. **Summary.** Sends the coin data, the post text, engagement and up to two attached images to Claude, which returns one sentence. Each coin is summarized once; buying more of it reuses that sentence and is marked `ADDED`.

## Safety

- Your key never leaves your machine. It's used only to sign the login message, which can't move funds; this tool never creates or sends transactions.
- Use a dedicated trading wallet anyway, and keep `.env` private (it's gitignored).

## Limits

- pump.fun's API isn't officially documented; if they change the login flow, login will fail with a warning, and buy detection and summaries keep working.
- X Communities can't be read without an X login, so coins that only link a community are summarized from their name and description.
- Calls aren't posted as pump.fun comments: pump.fun requires a captcha for comments.
- Summaries use `claude-opus-5-5` at low effort (override with `CLAUDE_MODEL`), which costs a few cents per new coin.

## Development

```bash
npm test           # unit tests (network is mocked)
npm run typecheck
```
