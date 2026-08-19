import { domainOf, type RankingSource, type SerpResult } from "./source";

interface SerperOrganicResult {
  position?: number;
  link: string;
  title?: string;
}

/**
 * Real Google rankings via serper.dev. One API credit per keyword per run;
 * the top-20 window keeps "entered/dropped out" meaningful at 1 credit/query.
 */
export class SerperSource implements RankingSource {
  readonly name = "serper";

  constructor(
    private apiKey: string,
    private options: { num?: number; fetchImpl?: typeof fetch } = {},
  ) {}

  async search(keyword: string, _trackedDomains: string[]): Promise<SerpResult[]> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: keyword,
        num: this.options.num ?? 20,
        gl: "us",
        hl: "en",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`serper responded ${response.status}: ${body.slice(0, 200)}`);
    }
    const json = (await response.json()) as { organic?: SerperOrganicResult[] };
    return parseSerperOrganic(json.organic ?? []);
  }
}

/** Exported separately so the parser is testable without a network. */
export function parseSerperOrganic(organic: SerperOrganicResult[]): SerpResult[] {
  return organic.map((result, index) => ({
    position: result.position ?? index + 1,
    url: result.link,
    domain: domainOf(result.link),
    title: result.title,
  }));
}
