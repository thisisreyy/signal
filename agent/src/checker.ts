/**
 * The core task: check a list of URLs. Pure logic — no Convex, no scheduling.
 * Fetch is injectable so tests never touch the network.
 */

export interface CheckResult {
  url: string;
  ok: boolean;
  statusCode?: number;
  latencyMs?: number;
  error?: string;
  checkedAt: number;
}

export interface CheckerOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function checkUrl(
  url: string,
  options: CheckerOptions = {},
): Promise<CheckResult> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = fetch,
    now = Date.now,
  } = options;

  const startedAt = now();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      url,
      ok: response.ok,
      statusCode: response.status,
      latencyMs: now() - startedAt,
      checkedAt: now(),
    };
  } catch (error) {
    return {
      url,
      ok: false,
      latencyMs: now() - startedAt,
      error: describeFetchError(error),
      checkedAt: now(),
    };
  }
}

function describeFetchError(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "timeout";
  }
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}
