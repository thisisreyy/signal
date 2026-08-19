import type { Doc } from "../../../convex/_generated/dataModel";

/**
 * Status is never color alone: every pill pairs an icon glyph with a label,
 * per the status-palette rule.
 */
export function CheckStatusPill({
  check,
}: {
  check: Pick<Doc<"checks">, "ok" | "statusCode" | "error">;
}) {
  if (check.error) {
    return (
      <span className="pill pill-critical" title={check.error}>
        <span className="pill-icon">✕</span> {check.error}
      </span>
    );
  }
  return check.ok ? (
    <span className="pill pill-good">
      <span className="pill-icon">✓</span> {check.statusCode}
    </span>
  ) : (
    <span className="pill pill-critical">
      <span className="pill-icon">✕</span> {check.statusCode}
    </span>
  );
}

export function ChangePill({ change }: { change?: Doc<"checks">["change"] }) {
  if (!change) return <span className="quiet">—</span>;
  switch (change.kind) {
    case "new":
      return (
        <span className="pill pill-new">
          <span className="pill-icon">＋</span> newly watched
        </span>
      );
    case "broke":
      return (
        <span className="pill pill-critical">
          <span className="pill-icon">▼</span> went down · was {change.prevStatusCode ?? "up"}
        </span>
      );
    case "recovered":
      return (
        <span className="pill pill-good">
          <span className="pill-icon">▲</span> back up
        </span>
      );
    case "statusChanged":
      return (
        <span className="pill pill-warning">
          <span className="pill-icon">Δ</span> was {change.prevStatusCode}
        </span>
      );
  }
}
