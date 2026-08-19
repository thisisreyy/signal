import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { DomainPosition, GrowthConfig, KeywordCheckResult } from "./growth/types";
import type { RunStore } from "./store";

/**
 * RunStore backed by real Convex over HTTP. Works identically from Bun and
 * from a Cloudflare Worker — ConvexHttpClient is fetch-based.
 */
export class ConvexRunStore implements RunStore {
  private client: ConvexHttpClient;

  constructor(convexUrl: string) {
    this.client = new ConvexHttpClient(convexUrl);
  }

  async recoverStaleRuns(): Promise<number> {
    return await this.client.mutation(api.runs.recoverStale, {});
  }

  async isPaused(): Promise<boolean> {
    const state = await this.client.query(api.admin.state, {});
    return state.paused;
  }

  async getConfig(): Promise<GrowthConfig> {
    const config = await this.client.query(api.admin.getConfig, {});
    return {
      business: config.business,
      keywords: config.keywords,
      competitors: config.competitors,
      injectFailure: config.injectFailure,
    };
  }

  async startRun(args: {
    runKey: string;
    trigger: "cron" | "manual";
    itemsTotal: number;
    source: string;
  }): Promise<{ runId: string; created: boolean }> {
    return await this.client.mutation(api.runs.start, args);
  }

  async getBaseline(): Promise<Record<string, DomainPosition[]>> {
    const entries = await this.client.query(api.runs.baseline, {});
    const baseline: Record<string, DomainPosition[]> = {};
    for (const entry of entries) {
      baseline[entry.keyword] = entry.positions;
    }
    return baseline;
  }

  async recordKeywordCheck(runId: string, result: KeywordCheckResult): Promise<void> {
    await this.client.mutation(api.keywordChecks.record, {
      runId: runId as Id<"runs">,
      keyword: result.keyword,
      error: result.error,
      positions: result.positions,
      changes: result.changes,
    });
  }

  async finishRun(
    runId: string,
    status: "succeeded" | "failed",
    error?: string,
  ): Promise<void> {
    await this.client.mutation(api.runs.finish, {
      runId: runId as Id<"runs">,
      status,
      error,
    });
  }
}
