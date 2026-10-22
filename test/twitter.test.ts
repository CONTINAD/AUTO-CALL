import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fetchTwitterContext, parseTwitterLink, pickTwitterLink, syndicationToken } from "../src/twitter.js";
import { json, mockFetch } from "./helpers.js";

let restore = () => {};
afterEach(() => restore());

test("parses tweet, profile and community links in their many forms", () => {
  const tweet = { kind: "tweet", id: "1850000000000000001", url: "https://x.com/i/status/1850000000000000001" };
  for (const raw of [
    "https://x.com/frog/status/1850000000000000001",
    "https://twitter.com/frog/status/1850000000000000001?s=46&t=abc",
    "x.com/frog/status/1850000000000000001/photo/1",
    "https://mobile.twitter.com/frog/status/1850000000000000001",
    "https://x.com/i/web/status/1850000000000000001",
    "https://fxtwitter.com/frog/status/1850000000000000001",
  ]) {
    assert.deepEqual(parseTwitterLink(raw), tweet, raw);
  }
  assert.deepEqual(parseTwitterLink("https://www.x.com/FrogCoin_"), {
    kind: "profile",
    handle: "FrogCoin_",
    url: "https://x.com/FrogCoin_",
  });
  assert.deepEqual(parseTwitterLink("https://x.com/i/communities/1900000000000000000"), {
    kind: "community",
    id: "1900000000000000000",
    url: "https://x.com/i/communities/1900000000000000000",
  });
  for (const raw of ["https://x.com/home", "https://x.com/search?q=frog", "https://t.me/frog", "https://netflix.com/x", "nonsense"]) {
    assert.equal(parseTwitterLink(raw), null, raw);
  }
});

test("prefers a tweet anywhere in the metadata over a profile", () => {
  assert.equal(
    pickTwitterLink({
      twitter: "https://x.com/frogcoin",
      website: "https://frog.xyz",
      description: "the frog. origin: https://x.com/someone/status/42 lol",
    })?.kind,
    "tweet",
  );
  assert.deepEqual(pickTwitterLink({ twitter: "@frogcoin" }), {
    kind: "profile",
    handle: "frogcoin",
    url: "https://x.com/frogcoin",
  });
  assert.equal(pickTwitterLink({ website: "https://netflix.com/status/1", description: "no links" }), null);
  assert.deepEqual(pickTwitterLink({ description: "see x.com/dev/status/987654321." }), {
    kind: "tweet",
    id: "987654321",
    url: "https://x.com/i/status/987654321",
  });
});

test("syndication token matches react-tweet's derivation", () => {
  const id = "1850000000000000001";
  assert.equal(syndicationToken(id), ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ""));
  assert.match(syndicationToken(id), /^[a-z1-9]+$/);
});

const fxStatus = {
  type: "status",
  url: "https://x.com/frog/status/42",
  text: "launching $FROG, the first frog on the moon",
  created_at: "Wed Oct 22 12:00:00 +0000 2026",
  likes: 1200,
  reposts: 300,
  views: 90000,
  author: { name: "Frog", screen_name: "frog", description: "ribbit", followers: 54000, verification: { verified: true } },
  media: { photos: [{ url: "https://pbs.twimg.com/media/a.jpg" }], videos: [{ thumbnail_url: "https://pbs.twimg.com/thumb.jpg" }] },
  quote: { type: "tombstone" },
};

test("reads a tweet through fxtwitter", async () => {
  restore = mockFetch({ "https://api.fxtwitter.com/2/status/42": () => json({ code: 200, status: fxStatus }) }).restore;
  const ctx = await fetchTwitterContext({ kind: "tweet", id: "42", url: "https://x.com/i/status/42" });
  assert.equal(ctx?.kind, "tweet");
  if (ctx?.kind !== "tweet") return;
  assert.equal(ctx.post.text, fxStatus.text);
  assert.equal(ctx.post.authorFollowers, 54000);
  assert.equal(ctx.post.authorVerified, true);
  assert.deepEqual(ctx.post.images, ["https://pbs.twimg.com/media/a.jpg", "https://pbs.twimg.com/thumb.jpg"]);
  assert.equal(ctx.post.quote, null, "deleted quote is dropped");
});

test("falls back to X's embed endpoint when fxtwitter is down", async () => {
  const mock = mockFetch({
    "https://api.fxtwitter.com/": () => new Response("bad gateway", { status: 502 }),
    "https://cdn.syndication.twimg.com/tweet-result": () =>
      json({
        id_str: "42",
        text: "gm frogs",
        favorite_count: 10,
        user: { name: "Frog", screen_name: "frog", followers_count: 5 },
        mediaDetails: [{ media_url_https: "https://pbs.twimg.com/media/b.jpg" }],
      }),
  });
  restore = mock.restore;
  const ctx = await fetchTwitterContext({ kind: "tweet", id: "42", url: "https://x.com/i/status/42" });
  assert.equal(ctx?.kind === "tweet" && ctx.post.text, "gm frogs");
  assert.match(mock.requests[1]!.url, /id=42&lang=en&token=[a-z1-9]+$/);
});

test("deleted tweets return null without hitting the fallback", async () => {
  const mock = mockFetch({
    "https://api.fxtwitter.com/2/status/": () => json({ code: 404, status: { type: "tombstone", reason: "deleted" } }),
  });
  restore = mock.restore;
  assert.equal(await fetchTwitterContext({ kind: "tweet", id: "42", url: "" }), null);
  assert.equal(mock.requests.length, 1);
});

test("reads a profile with its recent posts", async () => {
  restore = mockFetch({
    "https://api.fxtwitter.com/2/profile/frog/statuses": () => json({ code: 200, results: [fxStatus, fxStatus] }),
    "https://api.fxtwitter.com/2/profile/frog": () =>
      json({ code: 200, user: { name: "Frog", screen_name: "frog", description: "ribbit", followers: 54000 } }),
  }).restore;
  const ctx = await fetchTwitterContext({ kind: "profile", handle: "frog", url: "https://x.com/frog" });
  assert.equal(ctx?.kind, "profile");
  if (ctx?.kind !== "profile") return;
  assert.equal(ctx.profile.bio, "ribbit");
  assert.equal(ctx.recent.length, 2);
});
