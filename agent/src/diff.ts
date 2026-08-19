/**
 * Compare one check result against the same URL's result in the baseline
 * (the last successful run). Returns undefined when nothing changed —
 * that absence is what the schema stores.
 */

export interface BaselineEntry {
  ok: boolean;
  statusCode?: number;
}

export interface Change {
  kind: "new" | "broke" | "recovered" | "statusChanged";
  prevOk?: boolean;
  prevStatusCode?: number;
}

export function diffAgainstBaseline(
  current: { ok: boolean; statusCode?: number },
  baseline: BaselineEntry | undefined,
): Change | undefined {
  if (!baseline) {
    return { kind: "new" };
  }
  const prev = { prevOk: baseline.ok, prevStatusCode: baseline.statusCode };
  if (baseline.ok && !current.ok) {
    return { kind: "broke", ...prev };
  }
  if (!baseline.ok && current.ok) {
    return { kind: "recovered", ...prev };
  }
  if (baseline.statusCode !== current.statusCode) {
    return { kind: "statusChanged", ...prev };
  }
  return undefined;
}
