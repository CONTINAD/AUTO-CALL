import assert from "node:assert/strict";
import { test } from "node:test";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { loadConfig, parsePrivateKey } from "../src/config.js";

const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const address = bs58.encode(kp.publicKey);

test("parses a base58 64-byte secret key (Phantom export)", () => {
  const wallet = parsePrivateKey(bs58.encode(kp.secretKey));
  assert.equal(wallet.address, address);
  assert.deepEqual(wallet.secretKey, kp.secretKey);
});

test("parses a JSON byte array (solana-keygen file)", () => {
  const wallet = parsePrivateKey(JSON.stringify(Array.from(kp.secretKey)));
  assert.equal(wallet.address, address);
});

test("parses a 32-byte seed", () => {
  assert.equal(parsePrivateKey(bs58.encode(kp.secretKey.slice(0, 32))).address, address);
});

test("rejects a key whose public half doesn't match", () => {
  const bad = Uint8Array.from(kp.secretKey);
  bad[63] = (bad[63]! + 1) % 256;
  assert.throws(() => parsePrivateKey(bs58.encode(bad)), /corrupted/);
});

test("rejects garbage without echoing it", () => {
  for (const input of ["not-base58-0OIl", "[1,2,3]", "[999]", "[1,2"]) {
    assert.throws(
      () => parsePrivateKey(input),
      (err: Error) => !err.message.includes(input),
    );
  }
});

test("loadConfig defaults and validation", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.wallet, null);
  assert.equal(cfg.model, "claude-opus-5-5");
  assert.equal(cfg.pollIntervalMs, 3000);
  assert.equal(cfg.telegram, null);
  assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: "x" }), /TELEGRAM_CHAT_ID/);
  assert.throws(() => loadConfig({ POLL_INTERVAL_MS: "10" }), /POLL_INTERVAL_MS/);
  assert.deepEqual(loadConfig({ TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "-100" }).telegram, {
    botToken: "t",
    chatId: "-100",
  });
});
