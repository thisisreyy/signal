/**
 * Run the growth agent once from the command line against a real Convex
 * deployment:
 *   CONVEX_URL=... [SERPER_API_KEY=...] bun run src/cli.ts [runKey]
 * Uses real Google data via Serper when the key is set; otherwise the
 * clearly-labeled simulated source.
 */
import { ConvexRunStore } from "./convexStore";
import { SerperSource } from "./ranking/serper";
import { SimulatedSource } from "./ranking/simulated";
import { executeRun } from "./runner";

const convexUrl = process.env.CONVEX_URL;
if (!convexUrl) {
  console.error("CONVEX_URL is required");
  process.exit(1);
}

const serperKey = process.env.SERPER_API_KEY;
const source = serperKey
  ? new SerperSource(serperKey)
  : new SimulatedSource({
      // Demo knob: shrink the drift bucket so back-to-back manual runs can
      // produce ranking changes (default is 10 minutes).
      bucketMs: Number(process.env.SIM_BUCKET_MS) || undefined,
    });
console.error(`data source: ${source.name}`);

const runKey = process.argv[2] ?? `manual-${crypto.randomUUID()}`;
const outcome = await executeRun({
  store: new ConvexRunStore(convexUrl),
  source,
  runKey,
  trigger: "manual",
});
console.log(JSON.stringify(outcome, null, 2));
