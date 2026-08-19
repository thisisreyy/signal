import { useEffect, useState } from "react";

// In production the dashboard is served BY the worker, so relative URLs are
// always correct — VITE_WORKER_URL is honored only in dev, where Vite (5173)
// and wrangler (8787) are separate processes.
const WORKER_URL = import.meta.env.DEV
  ? ((import.meta.env.VITE_WORKER_URL as string | undefined) ?? "http://localhost:8787")
  : "";

export async function triggerCheck(): Promise<void> {
  // One key per call: a retried request can't start a second run.
  const runKey = `manual-${crypto.randomUUID()}`;
  const response = await fetch(`${WORKER_URL}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runKey }),
  });
  if (!response.ok) throw new Error(`The checker responded ${response.status}`);
}

/** Re-render every 30s so "2m ago" style labels stay fresh. */
export function useNowTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function faviconOf(url: string): string {
  try {
    return `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`;
  } catch {
    return "";
  }
}
