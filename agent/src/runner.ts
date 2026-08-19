import { checkUrl, type CheckerOptions } from "./checker";
import { diffAgainstBaseline } from "./diff";
import type { RunStore } from "./store";

export type RunOutcome =
  | { kind: "skipped"; reason: "paused" | "duplicate" }
  | { kind: "succeeded"; runId: string; urlsChecked: number }
  | { kind: "failed"; runId: string; urlsChecked: number; error: string };

/** Thrown deliberately mid-run when config.injectFailure is on (Phase 6). */
export class InjectedFailureError extends Error {
  constructor() {
    super("injected failure (config.injectFailure is on)");
    this.name = "InjectedFailureError";
  }
}

/**
 * Execute one agent run. Every durable effect goes through the store, and
 * each check is persisted the moment it completes, so a crash at any point
 * leaves consistent partial state for the recovery sweep to finalize.
 */
export async function executeRun(args: {
  store: RunStore;
  runKey: string;
  trigger: "cron" | "manual";
  checkerOptions?: CheckerOptions;
}): Promise<RunOutcome> {
  const { store, runKey, trigger, checkerOptions } = args;

  // 1. Sweep first: if a previous run crashed without finalizing, mark it
  //    failed now so history never shows a phantom "running" forever.
  await store.recoverStaleRuns();

  if (await store.isPaused()) {
    return { kind: "skipped", reason: "paused" };
  }

  const config = await store.getConfig();

  // 2. Claim the run. The store enforces insert-if-absent on runKey inside a
  //    transaction, so a double trigger gets created=false and does nothing.
  const { runId, created } = await store.startRun({
    runKey,
    trigger,
    itemsTotal: config.urls.length,
  });
  if (!created) {
    return { kind: "skipped", reason: "duplicate" };
  }

  // 3. Diff baseline = the last *successful* run, never a failed one.
  const baseline = await store.getBaseline();

  let urlsChecked = 0;
  try {
    for (const url of config.urls) {
      // Injected failure fires mid-run — after some checks have been
      // durably recorded — to prove partial state stays consistent.
      if (config.injectFailure && urlsChecked === injectionPoint(config.urls.length)) {
        throw new InjectedFailureError();
      }
      const result = await checkUrl(url, checkerOptions);
      const change = diffAgainstBaseline(result, baseline[url]);
      await store.recordCheck(runId, result, change);
      urlsChecked += 1;
    }
    await store.finishRun(runId, "succeeded");
    return { kind: "succeeded", runId, urlsChecked };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.finishRun(runId, "failed", message);
    return { kind: "failed", runId, urlsChecked, error: message };
  }
}

/** Fail after roughly half the URLs so the partial write is visible. */
function injectionPoint(urlCount: number): number {
  return Math.max(1, Math.floor(urlCount / 2));
}
