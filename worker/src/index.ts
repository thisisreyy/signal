/**
 * The scheduled runtime. A Cron Trigger fires the agent on a schedule, and a
 * small HTTP surface allows manual triggers and health checks. All state
 * lives in Convex — the Worker is deliberately stateless and replaceable.
 */
import { ConvexRunStore, executeRun, type RunOutcome } from "@signal/agent";

export interface Env {
  CONVEX_URL: string;
}

/**
 * The idempotency key for a cron run is derived from the scheduled time, so
 * two deliveries of the same tick (retry, overlapping invocation) share a key
 * and the second is a no-op in Convex.
 */
function cronRunKey(scheduledTime: number): string {
  return `cron-${new Date(scheduledTime).toISOString()}`;
}

async function runOnce(env: Env, runKey: string, trigger: "cron" | "manual"): Promise<RunOutcome> {
  const store = new ConvexRunStore(env.CONVEX_URL);
  const outcome = await executeRun({ store, runKey, trigger });
  console.log(`run ${runKey} (${trigger}):`, JSON.stringify(outcome));
  return outcome;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runOnce(env, cronRunKey(event.scheduledTime), "cron"));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/trigger") {
      // The caller may supply its own key (the dashboard sends one per click)
      // so a retried request cannot start a second run.
      const body = (await request.json().catch(() => ({}))) as { runKey?: string };
      const runKey = body.runKey ?? `manual-${crypto.randomUUID()}`;
      const outcome = await runOnce(env, runKey, "manual");
      return json({ runKey, outcome });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "signal-worker", convex: env.CONVEX_URL });
    }

    return json({ error: "not found" }, 404);
  },
};
