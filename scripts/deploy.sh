#!/usr/bin/env bash
# Deploys Signal for real: Convex production deployment + Cloudflare Worker.
# Prereqs (one time): `bun x convex login` and `bun x wrangler login`.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Deploying Convex and building the dashboard against the prod URL"
# --cmd runs the dashboard build with VITE_CONVEX_URL set to the production
# deployment URL; we also persist that URL for the worker deploy below.
bun x convex deploy \
  --cmd-url-env-var-name VITE_CONVEX_URL \
  --cmd 'cd dashboard && bun run build && printf "%s" "$VITE_CONVEX_URL" > ../.convex-prod-url'

CONVEX_URL=$(cat .convex-prod-url)
echo "==> Convex production URL: $CONVEX_URL"

echo "==> Deploying Cloudflare Worker (cron + trigger endpoint + dashboard)"
cd worker
bun x wrangler deploy --var CONVEX_URL:"$CONVEX_URL"

echo "==> Done. The workers.dev URL above is the live dashboard."
