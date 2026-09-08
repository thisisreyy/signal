#!/usr/bin/env bash
# Build + deploy the dashboard/worker, then PROVE the live site serves this
# exact build. Vite's content-hashed filenames make the check airtight: if
# the build silently failed and dist/ is stale, the hashes won't match what
# we just built — and if they somehow do, stale == current anyway.
set -euo pipefail
cd "$(dirname "$0")/.."

LIVE_URL="${LIVE_URL:-https://signal-worker.reydev.workers.dev}"

echo "==> Building dashboard (no pipes: a failure stops everything)"
(cd dashboard && VITE_CONVEX_URL="${VITE_CONVEX_URL:-https://brave-bass-198.convex.cloud}" bun run build)

echo "==> Deploying worker"
(cd worker && bun x wrangler deploy)

echo "==> Verifying live site serves the build we just made"
sleep 3
live_html=$(curl -fsS "$LIVE_URL/")
status=0
for asset in dashboard/dist/assets/*; do
  name=$(basename "$asset")
  if grep -q "$name" <<<"$live_html"; then
    echo "    ok: $name"
  else
    echo "    MISSING FROM LIVE HTML: $name"
    status=1
  fi
done
if [ "$status" -ne 0 ]; then
  echo "==> VERIFICATION FAILED: live site does not match local build" >&2
  exit 1
fi
echo "==> Verified: production serves this exact build."
