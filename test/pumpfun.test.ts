import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { parsePrivateKey } from "../src/config.js";
import { buildLoginPayload, extractAuthToken, jwtExpiry, PumpFunClient } from "../src/pumpfun.js";
import { json, mockFetch } from "./helpers.js";

const wallet = parsePrivateKey(bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).secretKey));
const MINT = "Coin1111111111111111111111111111111111pump";
let restore = () => {};
afterEach(() => restore());

function jwt(exp: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256" })}.${part({ address: wallet.address, exp })}.sig`;
}

test("login payload is a valid signature of pump.fun's sign-in message", () => {
  const payload = buildLoginPayload(wallet, 1_760_000_000_123);
  assert.equal(payload.address, wallet.address);
  assert.equal(payload.timestamp, 1_760_000_000_123);
  const ok = nacl.sign.detached.verify(
    new TextEncoder().encode("Sign in to pump.fun: 1760000000123"),
    bs58.decode(payload.signature),
    bs58.decode(wallet.address),
  );
  assert.ok(ok);
});

test("extracts auth_token from Set-Cookie and reads JWT expiry", () => {
  assert.equal(extractAuthToken(["other=1; Path=/", "auth_token=abc.def.ghi; HttpOnly"]), "abc.def.ghi");
  assert.equal(extractAuthToken(["other=1"]), null);
  assert.equal(jwtExpiry(jwt(1234)), 1234);
  assert.equal(jwtExpiry("garbage"), null);
});

test("logs in, sends the session on requests, and re-logs in after a 401", async () => {
  const token = jwt(Math.floor(Date.now() / 1000) + 3600);
  let logins = 0;
  let coinCalls = 0;
  const mock = mockFetch({
    "https://frontend-api-v3.pump.fun/auth/login": (req) => {
      logins++;
      const body = JSON.parse(req.body!);
      assert.equal(body.address, wallet.address);
      assert.equal(req.headers.get("origin"), "https://pump.fun");
      return json({ address: wallet.address }, { headers: { "set-cookie": `auth_token=${token}; Path=/; HttpOnly` } });
    },
    "https://frontend-api-v3.pump.fun/coins/": (req) => {
      coinCalls++;
      assert.equal(req.headers.get("cookie"), `auth_token=${token}`);
      assert.equal(req.headers.get("authorization"), `Bearer ${token}`);
      if (coinCalls === 1) return new Response("expired", { status: 401 });
      return json({ mint: MINT, name: "Frog", symbol: "FROG", twitter: "https://x.com/frog/status/1" });
    },
  });
  restore = mock.restore;

  const client = new PumpFunClient(wallet);
  await client.login();
  const coin = await client.getCoin(MINT);
  assert.equal(coin?.symbol, "FROG");
  assert.equal(logins, 2, "re-logged in once after the 401");
  assert.ok(mock.requests[1]!.url.endsWith(`/coins/${MINT}?sync=true`));
});

test("login failure surfaces the HTTP status", async () => {
  restore = mockFetch({
    "https://frontend-api-v3.pump.fun/auth/login": () => new Response("Forbidden by WAF", { status: 403 }),
  }).restore;
  await assert.rejects(new PumpFunClient(wallet).login(), /HTTP 403: Forbidden by WAF/);
});

test("works without a wallet for public reads", async () => {
  restore = mockFetch({
    "https://frontend-api-v3.pump.fun/coins/": () => new Response(null, { status: 404 }),
  }).restore;
  assert.equal(await new PumpFunClient(null).getCoin(MINT), null);
});
