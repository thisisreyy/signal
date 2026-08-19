import { describe, expect, test } from "bun:test";
import { diffAgainstBaseline } from "../src/diff";

describe("diffAgainstBaseline", () => {
  test("no baseline entry means the URL is new", () => {
    expect(diffAgainstBaseline({ ok: true, statusCode: 200 }, undefined)).toEqual(
      { kind: "new" },
    );
  });

  test("ok -> not ok is 'broke'", () => {
    expect(
      diffAgainstBaseline(
        { ok: false, statusCode: 500 },
        { ok: true, statusCode: 200 },
      ),
    ).toEqual({ kind: "broke", prevOk: true, prevStatusCode: 200 });
  });

  test("not ok -> ok is 'recovered'", () => {
    expect(
      diffAgainstBaseline({ ok: true, statusCode: 200 }, { ok: false }),
    ).toEqual({ kind: "recovered", prevOk: false, prevStatusCode: undefined });
  });

  test("ok both times with a different code is 'statusChanged'", () => {
    expect(
      diffAgainstBaseline(
        { ok: true, statusCode: 204 },
        { ok: true, statusCode: 200 },
      ),
    ).toEqual({ kind: "statusChanged", prevOk: true, prevStatusCode: 200 });
  });

  test("identical outcome is no change", () => {
    expect(
      diffAgainstBaseline(
        { ok: true, statusCode: 200 },
        { ok: true, statusCode: 200 },
      ),
    ).toBeUndefined();
  });
});
