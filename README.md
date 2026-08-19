# Signal

A reliable long-running agent with durable memory and a live dashboard.

The agent's task is deliberately simple — check the HTTP status and response
time of a configurable URL list on a schedule — because the point of this
project is not the task. The point is the reliability architecture around it:
every run is durable, idempotent, recoverable, observable, and controllable.

## Architecture

```
  cron (*/5)  ──▶ ┌─────────────────────────────┐
  POST /trigger ─▶│  Cloudflare Worker          │  stateless runtime
                  │  └─ @signal/agent (pure TS) │  also serves the built
                  └────────────┬────────────────┘  dashboard as assets
                               │  queries/mutations (HTTPS)
                               ▼
                  ┌─────────────────────────────┐
                  │  Convex                     │  all durable state
                  │  runs · checks              │  run history
                  │  agentState                 │  checkpoint + pause flag
                  │  config                     │  URL list + failure switch
                  └────────────┬────────────────┘
                               │  reactive subscription (WebSocket)
                               ▼
                  ┌─────────────────────────────┐
                  │  React dashboard (Vite)     │  live, no polling
                  └─────────────────────────────┘
```

Three packages plus the Convex backend, all TypeScript, all run with Bun:

| Path         | What it is                                                        |
| ------------ | ----------------------------------------------------------------- |
| `agent/`     | The task + run orchestration as a pure, tested library            |
| `convex/`    | Schema and functions — the only place durable state is touched    |
| `worker/`    | Cloudflare Worker: cron trigger, `POST /trigger`, dashboard host  |
| `dashboard/` | React UI reading Convex reactively                                |

The Worker is deliberately stateless and replaceable; if it is evicted, killed,
or double-invoked, no state is lost or corrupted, because every durable effect
is a Convex mutation with transactional semantics.

## The five reliability guarantees, and where they are enforced

**1. Durable memory.** Every run is a `runs` document; every URL result is a
`checks` document written *the moment the check completes*
(`agent/src/runner.ts`, loop in `executeRun`). Nothing is buffered until the
end of a run, so a crash can lose at most the single in-flight check. The
"last known good" state is a checkpoint (`agentState.lastSuccessfulRunId`),
not a cache — it survives worker restarts, deploys, and failures.

**2. Recovery.** Two mechanisms, both in `convex/runs.ts`:

- The checkpoint only advances inside the `finish` mutation and only when
  `status === "succeeded"` — and it advances in the *same transaction* that
  marks the run succeeded, so "run succeeded" and "checkpoint moved" can never
  be observed apart. A run that fails partway keeps its partial results (they
  are real observations) but can never become the diff baseline; the next run
  diffs against the last *successful* run as if the failed run never happened.
- The `recoverStale` sweep runs at the start of every run: any run still
  `"running"` after 10 minutes crashed without finalizing (worker eviction,
  network loss mid-run) and is marked `failed` so history stays honest and
  nothing ever waits on a phantom run.

**3. Idempotency.** Every run has a `runKey`. Cron runs derive it from the
scheduled tick time (`worker/src/index.ts:cronRunKey`), and the dashboard
generates one UUID per click, so retries reuse the same key. The `runs.start`
mutation does check-then-insert on an index over `runKey` — and because Convex
mutations are serializable transactions, a double trigger cannot race: the
second caller gets `created: false` and `executeRun` returns without doing any
work. This is enforced in the database, not in the runtime, so it holds even
across two workers triggering concurrently.

**4. Observability.** The dashboard subscribes to Convex queries
(`runs.list`, `runs.get`, `admin.state`) over a WebSocket — no polling. Every
run shows its status, trigger source, per-URL status/latency/error, progress
(`urlsCompleted/urlsTotal` makes partial failure visible as e.g. "1/3"), and
what changed vs. the last successful run. Diffs are computed at write time and
stored on the check row, so history is immutable and self-describing.

**5. Safe intervention.** Pause/resume flips `agentState.paused`; the runner
checks it before claiming a run, so pausing can never interrupt a run halfway —
it only prevents new ones. Manual trigger goes through exactly the same
`executeRun` path as cron, with the same idempotency, so an operator clicking
"Run now" during a cron tick cannot cause double-processing.

### The failure-injection proof

Flip **Inject failure** in the dashboard (or
`bun x convex run admin:setInjectFailure '{"injectFailure": true}'`) and
trigger a run. The runner throws deliberately after recording roughly half the
checks (`agent/src/runner.ts:InjectedFailureError`). You will see, live:

1. The run turns `failed` with partial results (e.g. 1/3 URLs) — kept, not
   rolled back, clearly marked.
2. The checkpoint does not move (`admin:state` still points at the previous
   successful run).
3. Untoggle and run again: the new run succeeds, diffs against the last
   *successful* run — the failed run is transparent to diffing — and the
   checkpoint advances.

The same scenario is pinned down in `agent/test/runner.test.ts`
("injected mid-run failure…" and "recovery: the run after a failure…").

## Running locally

Prereqs: [Bun](https://bun.sh) ≥ 1.3, Node ≥ 22 (wrangler runs on Node).

```sh
bun install
bun test                # 15 unit tests (checker, diffing, runner guarantees)
bun run typecheck

# Terminal 1 — Convex (local dev deployment; add `--local` to stay anonymous)
bun run dev:convex

# Terminal 2 — Worker on :8787 (cron simulation + trigger endpoint + dashboard)
bun run dev:worker

# Terminal 3 — dashboard with hot reload on :5173 (optional; :8787 serves the
# last built dashboard already)
bun run dev:dashboard
```

Local env files (created by the tools, or copy these):

- `.env.local` — written by `convex dev`; `CONVEX_URL=http://127.0.0.1:3210`
- `worker/.dev.vars` — `CONVEX_URL=http://127.0.0.1:3210`
- `dashboard/.env.local` — `VITE_CONVEX_URL=http://127.0.0.1:3210` and
  `VITE_WORKER_URL=http://localhost:8787`

Simulate a cron tick locally:
`curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`.
Trigger manually: `curl -X POST http://localhost:8787/trigger`.
Run the agent without the worker: `cd agent && CONVEX_URL=http://127.0.0.1:3210 bun run src/cli.ts`.

## Deploying

One-time logins, then one script:

```sh
bun x convex login
cd worker && bun x wrangler login && cd ..
bun run deploy
```

`scripts/deploy.sh` deploys Convex to a production deployment, builds the
dashboard with `VITE_CONVEX_URL` pointed at it, and deploys the Worker (cron
trigger + `/trigger` endpoint + dashboard assets) with `CONVEX_URL` set to the
same deployment. The workers.dev URL it prints is the live dashboard. The cron
schedule lives in `worker/wrangler.jsonc` (`*/5 * * * *`).

## Design decisions

**Checks are rows, not an array on the run.** The tempting model — a run
document with a `results[]` array — cannot express "the run died halfway"
without either losing the partial work or rewriting the whole document per
URL. One row per (run, URL), written as each check completes, makes partial
progress durable for free, gives the dashboard per-check reactivity, and
avoids unbounded document growth. The `(runId, url)` index doubles as the
upsert key, so re-recording a check is idempotent too.

**The checkpoint is not "the previous run".** Diffing against "the previous
run" breaks the moment a run fails: you'd diff against garbage or nothing.
`lastSuccessfulRunId` is a separate, deliberately boring pointer that only the
success path can move. Failed runs stay in history for humans but are
invisible to the diffing machinery.

**Idempotency is the database's job.** The worker could try to dedupe in
memory, but workers are stateless and can run concurrently — memory is the
wrong place. A transactional insert-if-absent on `runKey` in Convex is ~10
lines and holds under every interleaving. Deriving cron keys from the
scheduled time (rather than "now") means even a delayed redelivery of the same
tick dedupes correctly.

**Diffs are computed at write time.** Computing "what changed" in a dashboard
query would be cheaper to write, but it makes history mutable — edit the URL
list and old diffs silently recompute differently. Stored diffs make each run
a self-contained record of what the agent believed at the time, which is what
you want when you're debugging an incident three days later.

**The worker serves the dashboard.** Not essential, but it collapses deploy
surface area: one `wrangler deploy` gives one URL for UI + API + cron, and the
dashboard can call `/trigger` same-origin. The UI still talks to Convex
directly over its own WebSocket; the worker is not a proxy in that path.

**Pause blocks claiming, not execution.** Checking `paused` once before
`startRun` (rather than between URLs) means a pause can never leave a run
half-finished. The trade-off — a pause during a run doesn't stop that run —
is the safer default: runs take seconds, and "no run is ever interrupted" is
a much easier invariant to reason about than resumable interruption.
