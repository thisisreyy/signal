import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { CheckResult } from "./checker";
import type { BaselineEntry, Change } from "./diff";
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

  async getConfig(): Promise<{ urls: string[]; injectFailure: boolean }> {
    return await this.client.query(api.admin.getConfig, {});
  }

  async startRun(args: {
    runKey: string;
    trigger: "cron" | "manual";
    urlsTotal: number;
  }): Promise<{ runId: string; created: boolean }> {
    return await this.client.mutation(api.runs.start, args);
  }

  async getBaseline(): Promise<Record<string, BaselineEntry>> {
    const entries = await this.client.query(api.runs.baseline, {});
    const baseline: Record<string, BaselineEntry> = {};
    for (const entry of entries) {
      baseline[entry.url] = { ok: entry.ok, statusCode: entry.statusCode };
    }
    return baseline;
  }

  async recordCheck(
    runId: string,
    result: CheckResult,
    change: Change | undefined,
  ): Promise<void> {
    await this.client.mutation(api.checks.record, {
      runId: runId as Id<"runs">,
      url: result.url,
      ok: result.ok,
      statusCode: result.statusCode,
      latencyMs: result.latencyMs,
      error: result.error,
      change,
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
