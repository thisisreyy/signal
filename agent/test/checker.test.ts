import { describe, expect, test } from "bun:test";
import { checkUrl } from "../src/checker";

function fakeFetch(handler: (url: string) => Response | Promise<Response>) {
  return (async (input: RequestInfo | URL) =>
    handler(String(input))) as typeof fetch;
}

describe("checkUrl", () => {
  test("healthy URL yields ok with status and latency", async () => {
    let tick = 1000;
    const result = await checkUrl("https://a.test", {
      fetchImpl: fakeFetch(() => new Response("ok", { status: 200 })),
      now: () => (tick += 25),
    });
    expect(result).toMatchObject({
      url: "https://a.test",
      ok: true,
      statusCode: 200,
      latencyMs: 25,
    });
    expect(result.error).toBeUndefined();
  });

  test("HTTP error status yields ok=false but keeps the status code", async () => {
    const result = await checkUrl("https://a.test", {
      fetchImpl: fakeFetch(() => new Response("boom", { status: 503 })),
    });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(503);
    expect(result.error).toBeUndefined();
  });

  test("network failure yields ok=false with an error message", async () => {
    const result = await checkUrl("https://a.test", {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBeUndefined();
    expect(result.error).toBe("ECONNREFUSED");
  });

  test("timeout is reported as such", async () => {
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal!.reason),
        );
      })) as typeof fetch;
    const result = await checkUrl("https://slow.test", {
      fetchImpl: hangingFetch,
      timeoutMs: 10,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
  });
});
