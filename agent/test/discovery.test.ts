import { describe, expect, test } from "bun:test";
import {
  backoffMs,
  callKey,
  classifyError,
  contentHash,
  htmlToText,
  pagesToFetch,
  profilePrompt,
  stepKey,
  validateProfile,
} from "../../convex/discovery/logic";

describe("derived idempotency keys", () => {
  test("same input always produces the same key", () => {
    expect(stepKey("run1", "PROFILE", "https://acme.com")).toBe(
      stepKey("run1", "PROFILE", "https://acme.com"),
    );
    expect(callKey("fetch", "run1:https://acme.com")).toBe(
      callKey("fetch", "run1:https://acme.com"),
    );
  });

  test("different run, step, or input produce different keys", () => {
    const base = stepKey("run1", "PROFILE", "https://acme.com");
    expect(stepKey("run2", "PROFILE", "https://acme.com")).not.toBe(base);
    expect(stepKey("run1", "FETCH_PAGES", "https://acme.com")).not.toBe(base);
    expect(stepKey("run1", "PROFILE", "https://other.com")).not.toBe(base);
  });

  test("hash is stable across calls", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash("hello")).not.toBe(contentHash("hello!"));
  });
});

describe("error classification", () => {
  test("rate limits, timeouts and 5xx are retryable", () => {
    expect(classifyError("anything", 429)).toBe("retryable");
    expect(classifyError("anything", 503)).toBe("retryable");
    expect(classifyError("connect timeout")).toBe("retryable");
    expect(classifyError("fetch failed")).toBe("retryable");
  });

  test("auth and validation failures are terminal", () => {
    expect(classifyError("anything", 401)).toBe("terminal");
    expect(classifyError("anything", 422)).toBe("terminal");
    expect(classifyError("malformed whatever")).toBe("terminal");
  });

  test("the injected crash heals through the retryable path", () => {
    expect(classifyError("injected crash (PROFILE, after-ledger)")).toBe("retryable");
  });
});

describe("backoff", () => {
  test("grows with attempts and stays within bounds", () => {
    const fixed = () => 0.5;
    const a1 = backoffMs(1, fixed);
    const a2 = backoffMs(2, fixed);
    const a3 = backoffMs(3, fixed);
    expect(a2).toBeGreaterThan(a1);
    expect(a3).toBeGreaterThan(a2);
    expect(backoffMs(20, fixed)).toBeLessThanOrEqual(5 * 60_000);
  });

  test("jitter keeps it above half the exponential", () => {
    expect(backoffMs(1, () => 0)).toBeGreaterThanOrEqual(2_500);
    expect(backoffMs(1, () => 0.999)).toBeLessThanOrEqual(5_000);
  });
});

describe("profile validation", () => {
  const good = {
    name: "Acme",
    what_they_sell: "invoicing software",
    audience: "b2b",
    buyer_type: "technical",
    price_point: null,
    business_stage: "startup",
    category: "invoicing software",
    field_confidence: { name: 0.9, price_point: 0.1 },
  };

  test("accepts a well-formed profile, nulls allowed", () => {
    const result = validateProfile(good);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.price_point).toBeNull();
      expect(result.profile.audience).toBe("b2b");
    }
  });

  test("rejects a missing field rather than guessing", () => {
    const { name, ...missing } = good;
    const result = validateProfile(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("name");
  });

  test("rejects an invalid audience value", () => {
    expect(validateProfile({ ...good, audience: "everyone" }).ok).toBe(false);
  });

  test("rejects out-of-range confidence", () => {
    expect(validateProfile({ ...good, field_confidence: { name: 1.4 } }).ok).toBe(false);
  });

  test("rejects non-object payloads", () => {
    expect(validateProfile("a profile as prose").ok).toBe(false);
    expect(validateProfile(null).ok).toBe(false);
  });
});

describe("page handling", () => {
  test("fetch plan is a small fixed set on the site origin", () => {
    const pages = pagesToFetch("https://acme.com/some/deep/path");
    expect(pages[0]).toBe("https://acme.com");
    expect(pages).toContain("https://acme.com/pricing");
    expect(pages.length).toBeLessThanOrEqual(4);
  });

  test("htmlToText strips scripts, styles and tags", () => {
    const text = htmlToText(
      "<html><script>evil()</script><style>.x{}</style><h1>Acme</h1><p>We sell invoices&nbsp;fast</p></html>",
    );
    expect(text).toContain("Acme");
    expect(text).toContain("We sell invoices");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("<h1>");
  });

  test("prompt includes every page and the null instruction", () => {
    const prompt = profilePrompt("https://acme.com", [
      { url: "https://acme.com", text: "hello" },
      { url: "https://acme.com/pricing", text: "" },
    ]);
    expect(prompt).toContain("https://acme.com/pricing");
    expect(prompt).toContain("null");
  });
});
