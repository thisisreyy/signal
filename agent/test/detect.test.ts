import { describe, expect, test } from "bun:test";
import { detectChanges } from "../src/growth/detect";
import type { DomainPosition } from "../src/growth/types";

function pos(domain: string, position: number | undefined, isBusiness = false): DomainPosition {
  return { domain, isBusiness, position };
}

describe("detectChanges", () => {
  test("no baseline means no changes — first sighting is silent", () => {
    expect(detectChanges(undefined, [pos("acme.com", 3, true)])).toEqual([]);
  });

  test("small jitter (±1) is ignored; a real move is reported", () => {
    const baseline = [pos("acme.com", 4, true)];
    expect(detectChanges(baseline, [pos("acme.com", 5, true)])).toEqual([]);
    expect(detectChanges(baseline, [pos("acme.com", 7, true)])).toEqual([
      { kind: "moved", domain: "acme.com", prevPosition: 4, position: 7 },
    ]);
  });

  test("entering and dropping out of the top N", () => {
    const baseline = [pos("acme.com", undefined, true), pos("rival.com", 6)];
    const current = [pos("acme.com", 9, true), pos("rival.com", undefined)];
    const changes = detectChanges(baseline, current);
    expect(changes).toContainEqual({ kind: "entered", domain: "acme.com", position: 9 });
    expect(changes).toContainEqual({ kind: "dropped_out", domain: "rival.com", prevPosition: 6 });
  });

  test("competitor overtaking the business is reported", () => {
    const baseline = [pos("acme.com", 3, true), pos("rival.com", 5)];
    const current = [pos("acme.com", 6, true), pos("rival.com", 4)];
    const changes = detectChanges(baseline, current);
    expect(changes).toContainEqual({
      kind: "overtaken",
      domain: "acme.com",
      competitor: "rival.com",
      prevPosition: 3,
      position: 6,
    });
  });

  test("business overtaking a competitor is reported", () => {
    const baseline = [pos("acme.com", 8, true), pos("rival.com", 2)];
    const current = [pos("acme.com", 1, true), pos("rival.com", 2)];
    const changes = detectChanges(baseline, current);
    expect(changes).toContainEqual({
      kind: "overtook",
      domain: "acme.com",
      competitor: "rival.com",
      prevPosition: 8,
      position: 1,
    });
  });

  test("a competitor that never ranks produces no overtake noise", () => {
    const baseline = [pos("acme.com", undefined, true), pos("ghost.com", undefined)];
    const current = [pos("acme.com", 5, true), pos("ghost.com", undefined)];
    const changes = detectChanges(baseline, current);
    expect(changes).toEqual([{ kind: "entered", domain: "acme.com", position: 5 }]);
  });

  test("a newly tracked domain has no baseline entry and stays silent", () => {
    const baseline = [pos("acme.com", 4, true)];
    const current = [pos("acme.com", 4, true), pos("newrival.com", 2)];
    expect(detectChanges(baseline, current)).toEqual([]);
  });
});
