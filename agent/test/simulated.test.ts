import { describe, expect, test } from "bun:test";
import { SimulatedSource } from "../src/ranking/simulated";

const TRACKED = ["acme.com", "rival.com", "other.com"];

describe("SimulatedSource", () => {
  test("is deterministic within a time bucket", async () => {
    const source = new SimulatedSource({ now: () => 1_000_000 });
    const a = await source.search("ai tools", TRACKED);
    const b = await source.search("ai tools", TRACKED);
    expect(a).toEqual(b);
    expect(a).toHaveLength(20);
    expect(a.map((r) => r.position)).toEqual(a.map((_, i) => i + 1));
  });

  test("drifts between buckets so change detection has signal", async () => {
    const bucketMs = 10 * 60 * 1000;
    const early = new SimulatedSource({ now: () => 0 });
    const later = new SimulatedSource({ now: () => bucketMs * 3 });
    const results: boolean[] = [];
    for (const keyword of ["alpha", "beta", "gamma", "delta"]) {
      const a = await early.search(keyword, TRACKED);
      const b = await later.search(keyword, TRACKED);
      results.push(JSON.stringify(a) !== JSON.stringify(b));
    }
    // At least one keyword's fabricated SERP moved across buckets.
    expect(results.some(Boolean)).toBe(true);
  });
});
