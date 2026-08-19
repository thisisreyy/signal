import { describe, expect, test } from "bun:test";
import { extractPositions } from "../src/growth/extract";
import { parseSerperOrganic } from "../src/ranking/serper";

describe("extractPositions", () => {
  const serp = [
    { position: 1, url: "https://www.rival.com/product", domain: "rival.com" },
    { position: 2, url: "https://blog.acme.com/post", domain: "blog.acme.com" },
    { position: 3, url: "https://other.example/", domain: "other.example" },
    { position: 4, url: "https://acme.com/", domain: "acme.com" },
  ];

  test("finds the best position for each tracked domain, subdomains included", () => {
    const positions = extractPositions(serp, "acme.com", ["rival.com", "missing.com"]);
    expect(positions).toEqual([
      { domain: "acme.com", isBusiness: true, position: 2, url: "https://blog.acme.com/post" },
      { domain: "rival.com", isBusiness: false, position: 1, url: "https://www.rival.com/product" },
      { domain: "missing.com", isBusiness: false, position: undefined, url: undefined },
    ]);
  });

  test("does not match lookalike domains", () => {
    const positions = extractPositions(
      [{ position: 1, url: "https://notacme.com/", domain: "notacme.com" }],
      "acme.com",
      [],
    );
    expect(positions[0]!.position).toBeUndefined();
  });
});

describe("parseSerperOrganic", () => {
  test("parses serper's organic results into positions and domains", () => {
    const results = parseSerperOrganic([
      { position: 1, link: "https://www.anthropic.com/claude", title: "Claude" },
      { link: "https://openai.com/chatgpt", title: "ChatGPT" }, // no position field
    ]);
    expect(results).toEqual([
      { position: 1, url: "https://www.anthropic.com/claude", domain: "anthropic.com", title: "Claude" },
      { position: 2, url: "https://openai.com/chatgpt", domain: "openai.com", title: "ChatGPT" },
    ]);
  });
});
