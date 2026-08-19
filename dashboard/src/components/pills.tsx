import type { Doc } from "../../../convex/_generated/dataModel";

/**
 * Status is never color alone: every pill pairs an icon glyph with a label,
 * per the status-palette rule.
 */
export function StatusPill({ status }: { status: Doc<"runs">["status"] }) {
  switch (status) {
    case "succeeded":
      return (
        <span className="pill pill-good">
          <span className="pill-icon">✓</span> ok
        </span>
      );
    case "failed":
      return (
        <span className="pill pill-critical">
          <span className="pill-icon">✕</span> failed
        </span>
      );
    case "running":
      return (
        <span className="pill pill-running">
          <span className="pill-icon pulse">●</span> running
        </span>
      );
  }
}

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
          <span className="pill-icon">＋</span> new URL
        </span>
      );
    case "broke":
      return (
        <span className="pill pill-critical">
          <span className="pill-icon">▼</span> broke · was {change.prevStatusCode ?? "ok"}
        </span>
      );
    case "recovered":
      return (
        <span className="pill pill-good">
          <span className="pill-icon">▲</span> recovered · was {change.prevStatusCode ?? "down"}
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
