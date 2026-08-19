/**
 * Run the agent once from the command line against a real Convex deployment:
 *   CONVEX_URL=... bun run src/cli.ts [runKey]
 * Useful for local end-to-end testing without the Worker.
 */
import { ConvexRunStore } from "./convexStore";
import { executeRun } from "./runner";

const convexUrl = process.env.CONVEX_URL;
if (!convexUrl) {
  console.error("CONVEX_URL is required");
  process.exit(1);
}

const runKey = process.argv[2] ?? `manual-${crypto.randomUUID()}`;
const outcome = await executeRun({
  store: new ConvexRunStore(convexUrl),
  runKey,
  trigger: "manual",
});
console.log(JSON.stringify(outcome, null, 2));
