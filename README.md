# Signal — an autonomous growth agent

A small, reliable growth agent: on a daily schedule it checks where your
business ranks on Google for a set of target keywords, where your competitors
rank for the same keywords, detects what changed ("dropped from #4 to #7 for
'ai recruiting tool'", "openai.com overtook you for 'llm api'"), and shows it
all on a live dashboard.

The task is growth/SEO monitoring, but the engineering point is **reliability**:
every run is durable, idempotent, recoverable, and observable. The agent can
crash mid-run, get triggered twice, or lose its data source, and state never
corrupts.

## Architecture

```
  cron (daily) ─▶ ┌─────────────────────────────┐     ┌──────────────┐
  POST /trigger ─▶│  Cloudflare Worker          │────▶│ RankingSource │ swappable:
                  │  └─ @signal/agent (pure TS) │     │  serper.dev   │ real Google
                  └────────────┬────────────────┘     │  simulated    │ demo/tests
                               │  queries/mutations   └──────────────┘
                               ▼
                  ┌─────────────────────────────┐
                  │  Convex                     │  all durable state
                  │  runs · keywordChecks       │  run history + rankings
                  │  agentState                 │  checkpoint + pause flag
                  │  config                     │  business/keywords/competitors
                  └────────────┬────────────────┘
                               │  reactive subscription (WebSocket)
                               ▼
                  ┌─────────────────────────────┐
                  │  React dashboard (Vite)     │  live, no polling
                  └─────────────────────────────┘
```

| Path         | What it is                                                              |
| ------------ | ----------------------------------------------------------------------- |
| `agent/`     | The growth task as a pure, tested library: sources, extraction, change detection, run orchestration |
| `convex/`    | Schema and functions — the only place durable state is touched          |
| `worker/`    | Cloudflare Worker: daily cron, `POST /trigger`, serves the dashboard    |
| `dashboard/` | React UI reading Convex reactively                                      |

The Worker is stateless and replaceable; every durable effect is a Convex
mutation with transactional semantics.

## The data source (and why it's swappable)

Real ranking data is the fragile part, so it lives behind one interface
(`agent/src/ranking/source.ts`): `search(keyword) → ordered results`. Two
implementations ship:

- **serper.dev** (`SerperSource`) — real Google results. Chosen because a
  growth agent's product *is* Google positions, the API is a clean JSON POST
  that works from Workers, and the free tier (2,500 credits, one-time) lasts
  ~2 years at this project's default usage. Honest risks: credits don't renew
  (after that it's paid), and the key is a secret to manage. Activated simply
  by setting `SERPER_API_KEY`.
- **simulated** (`SimulatedSource`) — deterministic fabricated rankings that
  drift over time. Used by unit tests and as the no-key demo mode; the
  dashboard labels it "demo data". This is not a platform mock — Convex and
  the Worker are always real — it's the swappability requirement doing its job.

Cost model: **one query per keyword per run**, independent of competitor
count — a single top-20 fetch is scanned for the business *and* every
competitor. Daily cadence × 3 keywords ≈ 90 queries/month. A single keyword's
fetch failure is recorded as data on that keyword (and excluded from future
diff baselines); only *all* keywords failing fails the run.

## The reliability guarantees, and where they are enforced

**Durable memory.** Each keyword's result is written to `keywordChecks` the
moment its SERP fetch completes (`agent/src/runner.ts`) — nothing is buffered
until run end, so a crash loses at most one in-flight keyword. History is
never rewritten; every run's positions and detected changes are immutable
records of what the agent saw.

**Idempotency.** Every run has a `runKey` — derived from the scheduled tick
for cron, one UUID per click for manual. `runs.start` (`convex/runs.ts`) does
check-then-insert on an index over `runKey`, and Convex mutations are
serializable transactions, so a double trigger cannot race: the second caller
gets `created: false` and does no work. Enforced in the database, not the
runtime.

**Recovery.** Two mechanisms in `convex/runs.ts`:
- The checkpoint (`agentState.lastSuccessfulRunId`) advances only inside the
  `finish` mutation, only on success, in the same transaction that marks the
  run succeeded. A failed run keeps its partial keyword rows (real
  observations) but can never become the diff baseline — the next run diffs
  against the last *successful* run as if the failure never happened.
- A `recoverStale` sweep at the start of every run marks runs stuck in
  "running" for 10+ minutes (worker eviction, network loss) as failed, so
  history stays honest.

**Observability.** The dashboard subscribes to Convex over WebSocket: current
position per keyword with competitor comparison, position-over-time
sparklines, a plain-English signals feed of every detected change, and the
full run history with per-keyword detail and progress (a crashed run shows
"1 of 3 keywords done"). Diffs are computed at write time and stored, so
history is self-describing.

**Safe intervention.** Pause flips a flag the runner checks *before* claiming
a run — pausing can never interrupt one halfway. Manual triggers use exactly
the cron path with the same idempotency. The "Simulate a crash" button arms a
failure flag, triggers a run that deliberately throws midway, and disarms —
the feed then shows the crash and the self-heal.

### Change detection (the brain)

`agent/src/growth/detect.ts`, pure and unit-tested: per-domain
`entered` / `dropped_out` of the top 20, `moved` only when |Δ| ≥ 2 (±1 jitter
stays quiet), and business-vs-competitor order flips (`overtaken`/`overtook`)
ignoring competitors that never rank. A keyword with no baseline (first run,
newly added) produces no changes — a day-one flood of "entered" is noise.

## Running locally

Prereqs: [Bun](https://bun.sh) ≥ 1.3, Node ≥ 22 (wrangler runs on Node).

```sh
bun install
bun test              # 21 unit tests: sources, extraction, detection, runner guarantees
bun run typecheck

bun run dev:convex    # terminal 1 — local Convex deployment
bun run dev:worker    # terminal 2 — Worker on :8787 (also serves built dashboard)
bun run dev:dashboard # terminal 3 — hot-reload dashboard on :5173 (optional)
```

Local env: `.env.local` (written by `convex dev`) and `worker/.dev.vars` with
`CONVEX_URL=http://127.0.0.1:3210`; add `SERPER_API_KEY=...` to `.dev.vars`
for real Google data locally.

Useful:
- Simulate the daily cron tick: `curl "http://localhost:8787/__scheduled?cron=0+6+*+*+*"`
- Manual run: `curl -X POST http://localhost:8787/trigger`
- CLI run without the worker: `cd agent && CONVEX_URL=http://127.0.0.1:3210 bun run src/cli.ts`
  (`SIM_BUCKET_MS=60000` makes the simulated source drift fast enough to see
  changes between back-to-back runs)

## Deploying

```sh
bun x convex login
cd worker && bun x wrangler login && cd ..
bun run deploy
# then, for real Google data:
cd worker && bun x wrangler secret put SERPER_API_KEY
```

`scripts/deploy.sh` deploys Convex to production, builds the dashboard
against the production URL, and deploys the Worker (daily cron + `/trigger` +
dashboard assets). The workers.dev URL it prints is the live dashboard. The
schedule lives in `worker/wrangler.jsonc`.

## Design decisions

**One SERP query serves everyone.** Rankings for the business and all
competitors come from scanning a single result page per keyword. Cost scales
with keywords, never with competitors — which is what makes a free tier last
years instead of weeks.

**Keyword results are rows, not an array on the run.** One row per
(run × keyword), written as completed, is what makes partial progress durable
and recovery trivial — the same modelling that carried the original URL
checker, deliberately preserved.

**The checkpoint is not "the previous run".** Diffing against "the previous
run" breaks the moment one fails. `lastSuccessfulRunId` is a boring pointer
only the success path can move; failed runs stay visible to humans and
invisible to the diffing machinery.

**Changes are computed at write time and stored.** A dashboard-side diff
would silently recompute history whenever config changes. Stored changes make
each run a self-contained record — what you want when reading an incident
three days later.

**Errored keyword rows are excluded from baselines.** A rate-limited fetch
recorded as "no positions" would fabricate a "dropped out of top 20" signal
next run. Excluding errored rows from the baseline means transient
infrastructure failures can never masquerade as ranking movement.

**First sighting is silent.** No baseline → no changes. The alternative — a
wall of "entered top 20" on day one — teaches users to ignore the feed.

**The worker serves the dashboard.** One `wrangler deploy` gives one URL for
UI + API + cron. The UI still talks to Convex directly over its own
WebSocket; the worker is not a proxy in that path.
