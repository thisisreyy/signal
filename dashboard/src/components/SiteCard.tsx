import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { formatAgo } from "../format";
import { faviconOf, hostOf } from "../lib";
import { Sparkline } from "./Sparkline";

export interface Site {
  url: string;
  latest: {
    ok: boolean;
    statusCode?: number;
    latencyMs?: number;
    error?: string;
    checkedAt: number;
  } | null;
  history: { ok: boolean; latencyMs: number; checkedAt: number }[];
  uptimePct: number | null;
}

export function SiteCard({ site }: { site: Site }) {
  const removeUrl = useMutation(api.admin.removeUrl);
  const { latest } = site;
  const state = latest === null ? "pending" : latest.ok ? "up" : "down";

  return (
    <article className={`site site-${state}`}>
      <header className="site-top">
        <img
          className="site-favicon"
          src={faviconOf(site.url)}
          alt=""
          onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
        />
        <div className="site-names">
          <h3>{hostOf(site.url)}</h3>
          <span className="site-url" title={site.url}>{site.url}</span>
        </div>
        <button
          className="site-remove"
          title={`Stop watching ${hostOf(site.url)}`}
          aria-label={`Stop watching ${hostOf(site.url)}`}
          onClick={() => {
            if (confirm(`Stop watching ${hostOf(site.url)}?`)) {
              removeUrl({ url: site.url });
            }
          }}
        >
          ×
        </button>
      </header>

      <div className="site-status">
        {state === "pending" && <span className="badge badge-idle">◌ waiting for first check</span>}
        {state === "up" && <span className="badge badge-up">✓ Up</span>}
        {state === "down" && (
          <span className="badge badge-down" title={latest?.error}>
            ✕ Down{latest?.statusCode ? ` · ${latest.statusCode}` : ""}
          </span>
        )}
        {latest?.latencyMs !== undefined && (
          <span className="site-latency">{latest.latencyMs}<small>ms</small></span>
        )}
      </div>

      {site.history.length >= 2 && (
        <Sparkline
          points={site.history.map((h) => ({
            label: formatAgo(h.checkedAt),
            value: h.latencyMs,
          }))}
          formatValue={(v) => `${v}ms`}
          width={200}
          height={40}
        />
      )}

      <footer className="site-foot">
        {site.uptimePct !== null && <span>{site.uptimePct}% up · last {site.history.length} checks</span>}
        {latest && <span>checked {formatAgo(latest.checkedAt)}</span>}
      </footer>
    </article>
  );
}

export function AddSiteCard() {
  const addUrl = useMutation(api.admin.addUrl);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    let url = value.trim();
    if (!url) return;
    if (!/^https?:\/\//.test(url)) url = `https://${url}`;
    setBusy(true);
    setError(null);
    try {
      await addUrl({ url });
      setValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message.split("Uncaught Error:").pop()!.trim() : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="site site-add" onSubmit={submit}>
      <h3>Watch a new site</h3>
      <div className="add-row">
        <input
          type="text"
          placeholder="example.com"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          aria-label="Website address"
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !value.trim()}>
          Add
        </button>
      </div>
      {error ? (
        <span className="add-error">{error}</span>
      ) : (
        <span className="add-hint">It joins the very next check — no setup.</span>
      )}
    </form>
  );
}
