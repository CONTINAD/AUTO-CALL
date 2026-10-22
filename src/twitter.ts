import { errorMessage, getJson } from "./http.js";

export type TwitterLink =
  | { kind: "tweet"; id: string; url: string }
  | { kind: "profile"; handle: string; url: string }
  | { kind: "community"; id: string; url: string };

export interface Post {
  url: string;
  text: string;
  authorName: string;
  authorHandle: string;
  authorFollowers: number | null;
  authorVerified: boolean;
  createdAt: string | null;
  likes: number | null;
  reposts: number | null;
  views: number | null;
  /** Photo URLs (or video thumbnails) attached to the post. */
  images: string[];
  quote: Post | null;
  community: string | null;
}

export interface Profile {
  handle: string;
  name: string;
  bio: string;
  followers: number | null;
  verified: boolean;
}

export type TwitterContext =
  | { kind: "tweet"; link: TwitterLink; post: Post }
  | { kind: "profile"; link: TwitterLink; profile: Profile; recent: Post[] }
  | { kind: "community"; link: TwitterLink };

const TWITTER_HOSTS = new Set(["x.com", "twitter.com", "fxtwitter.com", "vxtwitter.com", "fixupx.com", "fixvx.com"]);
const RESERVED_PATHS = new Set([
  "home", "explore", "search", "i", "intent", "hashtag", "share", "notifications",
  "messages", "settings", "compose", "login", "signup", "tos", "privacy", "communities",
]);
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
// Boundary lookbehind so "netflix.com/..." isn't read as an x.com link.
const URL_IN_TEXT = /(?<![\w.-])(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com\/[^\s)"'<>\]]+/gi;

export function parseTwitterLink(raw: string): TwitterLink | null {
  let input = raw.trim();
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|mobile)\./, "");
  if (!TWITTER_HOSTS.has(host)) return null;

  const parts = url.pathname.split("/").filter(Boolean);
  const statusAt = parts.findIndex((p) => p === "status" || p === "statuses");
  const id = parts[statusAt + 1];
  if (statusAt >= 0 && id && /^\d+$/.test(id)) {
    return { kind: "tweet", id, url: `https://x.com/i/status/${id}` };
  }
  if (parts[0] === "i" && parts[1] === "communities" && parts[2] && /^\d+$/.test(parts[2])) {
    return { kind: "community", id: parts[2], url: `https://x.com/i/communities/${parts[2]}` };
  }
  const handle = parts[0];
  if (handle && HANDLE.test(handle) && !RESERVED_PATHS.has(handle.toLowerCase())) {
    return { kind: "profile", handle, url: `https://x.com/${handle}` };
  }
  return null;
}

/**
 * Picks the most useful X link for a coin. A specific tweet beats a profile,
 * which beats a community. Coins often put the launch tweet in the website or
 * description instead of the twitter field, so all three are searched.
 */
export function pickTwitterLink(fields: {
  twitter?: string | null;
  website?: string | null;
  description?: string | null;
}): TwitterLink | null {
  const links: TwitterLink[] = [];
  const twitter = fields.twitter?.trim();
  if (twitter) {
    const bare = twitter.replace(/^@/, "");
    const link = HANDLE.test(bare) ? parseTwitterLink(`x.com/${bare}`) : parseTwitterLink(twitter);
    if (link) links.push(link);
  }
  for (const text of [fields.website, fields.description]) {
    for (const match of text?.match(URL_IN_TEXT) ?? []) {
      // Drop sentence punctuation stuck to the end of a URL ("…/status/123.").
      const link = parseTwitterLink(match.replace(/[.,!?;:]+$/, ""));
      if (link) links.push(link);
    }
  }
  return (
    links.find((l) => l.kind === "tweet") ??
    links.find((l) => l.kind === "profile") ??
    links.find((l) => l.kind === "community") ??
    null
  );
}

export async function fetchTwitterContext(link: TwitterLink): Promise<TwitterContext | null> {
  switch (link.kind) {
    case "tweet": {
      const post = await fetchPost(link.id);
      return post ? { kind: "tweet", link, post } : null;
    }
    case "profile": {
      const profile = await fetchProfile(link.handle);
      if (!profile) return null;
      const recent = await fetchRecentPosts(link.handle).catch((err) => {
        console.error(`[twitter] couldn't load @${link.handle}'s recent posts: ${errorMessage(err)}`);
        return [];
      });
      return { kind: "profile", link, profile, recent };
    }
    case "community":
      // Communities can't be read without an X login; the summary falls back to coin metadata.
      return { kind: "community", link };
  }
}

// --- FxTwitter (api.fxtwitter.com): free, no key, returns full posts and profiles ---

const FX = "https://api.fxtwitter.com";

interface FxUser {
  name: string;
  screen_name: string;
  description: string;
  followers: number;
  verification?: { verified: boolean };
}

interface FxStatus {
  type: "status" | "tombstone";
  url: string;
  text: string;
  created_at: string;
  likes: number;
  reposts: number;
  views?: number | null;
  author: FxUser;
  media?: {
    photos?: { url: string }[];
    videos?: { thumbnail_url?: string | null }[];
  };
  quote?: FxStatus;
  community?: { name: string };
}

function fromFx(s: FxStatus): Post {
  const images = [
    ...(s.media?.photos ?? []).map((p) => p.url),
    ...(s.media?.videos ?? []).flatMap((v) => (v.thumbnail_url ? [v.thumbnail_url] : [])),
  ];
  return {
    url: s.url,
    text: s.text,
    authorName: s.author.name,
    authorHandle: s.author.screen_name,
    authorFollowers: s.author.followers ?? null,
    authorVerified: s.author.verification?.verified ?? false,
    createdAt: s.created_at ?? null,
    likes: s.likes ?? null,
    reposts: s.reposts ?? null,
    views: s.views ?? null,
    images,
    quote: s.quote?.type === "status" ? fromFx(s.quote) : null,
    community: s.community?.name ?? null,
  };
}

async function fetchPost(id: string): Promise<Post | null> {
  try {
    const res = await getJson<{ status: FxStatus | null }>(`${FX}/2/status/${id}`);
    if (res?.status?.type === "status") return fromFx(res.status);
    if (res?.status?.type === "tombstone") return null; // deleted / private; syndication won't have it either
  } catch (err) {
    console.error(`[twitter] fxtwitter failed for ${id}, trying syndication: ${errorMessage(err)}`);
  }
  return fetchPostFromSyndication(id);
}

async function fetchProfile(handle: string): Promise<Profile | null> {
  const res = await getJson<{ user?: FxUser }>(`${FX}/2/profile/${encodeURIComponent(handle)}`);
  const user = res?.user;
  if (!user) return null;
  return {
    handle: user.screen_name,
    name: user.name,
    bio: user.description,
    followers: user.followers ?? null,
    verified: user.verification?.verified ?? false,
  };
}

async function fetchRecentPosts(handle: string): Promise<Post[]> {
  const res = await getJson<{ results?: FxStatus[] }>(
    `${FX}/2/profile/${encodeURIComponent(handle)}/statuses?count=5`,
  );
  return (res?.results ?? []).filter((s) => s.type === "status").slice(0, 5).map(fromFx);
}

// --- X's public embed endpoint (what embedded tweets on websites use): fallback for single posts ---

interface SyndicationTweet {
  __typename?: string;
  id_str: string;
  text: string;
  created_at?: string;
  favorite_count?: number;
  user: { name: string; screen_name: string; followers_count?: number; is_blue_verified?: boolean };
  mediaDetails?: { media_url_https: string }[];
  quoted_tweet?: SyndicationTweet;
}

/** Token the embed endpoint expects; same derivation as Vercel's react-tweet. */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

function fromSyndication(t: SyndicationTweet): Post {
  return {
    url: `https://x.com/${t.user.screen_name}/status/${t.id_str}`,
    text: t.text,
    authorName: t.user.name,
    authorHandle: t.user.screen_name,
    authorFollowers: t.user.followers_count ?? null,
    authorVerified: t.user.is_blue_verified ?? false,
    createdAt: t.created_at ?? null,
    likes: t.favorite_count ?? null,
    reposts: null,
    views: null,
    images: (t.mediaDetails ?? []).map((m) => m.media_url_https),
    quote: t.quoted_tweet?.user ? fromSyndication(t.quoted_tweet) : null,
    community: null,
  };
}

async function fetchPostFromSyndication(id: string): Promise<Post | null> {
  try {
    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${syndicationToken(id)}`;
    const tweet = await getJson<SyndicationTweet>(url);
    if (!tweet?.user || tweet.__typename === "TweetTombstone") return null;
    return fromSyndication(tweet);
  } catch (err) {
    console.error(`[twitter] syndication failed for ${id}: ${errorMessage(err)}`);
    return null;
  }
}
