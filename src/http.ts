export async function describeHttpError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
  return `HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`;
}

/** GET a JSON document. Returns null on 404; throws on other failures. */
export async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "auto-call/0.1", ...headers },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${new URL(url).host}: ${await describeHttpError(res)}`);
  return (await res.json()) as T;
}

export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // fetch() reports network problems as a bare "fetch failed"; the reason is in `cause`.
  return err.cause instanceof Error ? `${err.message} (${err.cause.message})` : err.message;
}
