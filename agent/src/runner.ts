import { detectChanges } from "./growth/detect";
import { extractPositions } from "./growth/extract";
import type { RankingSource } from "./ranking/source";
import type { RunStore } from "./store";

export type RunOutcome =
  | { kind: "skipped"; reason: "paused" | "duplicate" }
  | { kind: "succeeded"; runId: string; keywordsChecked: number }
  | { kind: "failed"; runId: string; keywordsChecked: number; error: string };

/** Thrown deliberately mid-run when config.injectFailure is on. */
export class InjectedFailureError extends Error {
  constructor() {
    super("injected failure (config.injectFailure is on)");
    this.name = "InjectedFailureError";
  }
}

/**
 * Execute one growth-agent run. Every durable effect goes through the store,
 * and each keyword's result is persisted the moment its SERP fetch completes,
 * so a crash at any point leaves consistent partial state for the recovery
 * sweep to finalize.
 */
export async function executeRun(args: {
  store: RunStore;
  source: RankingSource;
  runKey: string;
  trigger: "cron" | "manual";
}): Promise<RunOutcome> {
  const { store, source, runKey, trigger } = args;

  // 1. Sweep first: if a previous run crashed without finalizing, mark it
  //    failed now so history never shows a phantom "running" forever.
  await store.recoverStaleRuns();

  if (await store.isPaused()) {
    return { kind: "skipped", reason: "paused" };
  }

  const config = await store.getConfig();
  const trackedDomains = [config.business.domain, ...config.competitors];

  // 2. Claim the run. The store enforces insert-if-absent on runKey inside a
  //    transaction, so a double trigger gets created=false and does nothing.
  const { runId, created } = await store.startRun({
    runKey,
    trigger,
    itemsTotal: config.keywords.length,
    source: source.name,
  });
  if (!created) {
    return { kind: "skipped", reason: "duplicate" };
  }

  // 3. Diff baseline = the last *successful* run, never a failed one.
  const baseline = await store.getBaseline();

  let keywordsChecked = 0;
  let keywordsSucceeded = 0;
  let lastKeywordError = "";
  try {
    for (const keyword of config.keywords) {
      // Injected failure fires mid-run — after some keywords have been
      // durably recorded — to prove partial state stays consistent.
      if (
        config.injectFailure &&
        keywordsChecked === injectionPoint(config.keywords.length)
      ) {
        throw new InjectedFailureError();
      }

      try {
        const serp = await source.search(keyword, trackedDomains);
        const positions = extractPositions(serp, config.business.domain, config.competitors);
        const changes = detectChanges(baseline[keyword], positions);
        await store.recordKeywordCheck(runId, { keyword, positions, changes });
        keywordsSucceeded += 1;
      } catch (error) {
        // A single keyword's fetch failing (rate limit, timeout) is data,
        // not a crash: record it and keep going. Errored rows are excluded
        // from future baselines, so they can't fabricate changes.
        lastKeywordError = error instanceof Error ? error.message : String(error);
        await store.recordKeywordCheck(runId, {
          keyword,
          positions: [],
          changes: [],
          error: lastKeywordError,
        });
      }
      keywordsChecked += 1;
    }

    // Every keyword failing (dead API key, exhausted quota) is a failed run:
    // it must not become the checkpoint and the dashboard should say so.
    if (keywordsSucceeded === 0 && config.keywords.length > 0) {
      const message = `every keyword check failed; last error: ${lastKeywordError}`;
      await store.finishRun(runId, "failed", message);
      return { kind: "failed", runId, keywordsChecked, error: message };
    }

    await store.finishRun(runId, "succeeded");
    return { kind: "succeeded", runId, keywordsChecked };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.finishRun(runId, "failed", message);
    return { kind: "failed", runId, keywordsChecked, error: message };
  }
}

/** Fail after roughly half the keywords so the partial write is visible. */
function injectionPoint(keywordCount: number): number {
  return Math.max(1, Math.floor(keywordCount / 2));
}
