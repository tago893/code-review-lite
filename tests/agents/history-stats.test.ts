import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_HISTORY_STATE, parseHistoryState, readHistoryState } from "../../src/agents/history-stats.js";

const line = (o: object): string => JSON.stringify(o);

describe("parseHistoryState", () => {
  it("summarises loaded, prune and stamp records", () => {
    const text = [line({ kind: "loaded", budget: 8000 }), line({ kind: "prune", toolResults: 2, kept: 2, pruned: 0, keptBytes: 500, savedBytes: 0 }), line({ kind: "stamp" }),
      line({ kind: "prune", toolResults: 5, kept: 2, pruned: 3, keptBytes: 900, savedBytes: 4000 }), line({ kind: "stamp" })].join("\n");
    expect(parseHistoryState(text)).toEqual({ loaded: true, errors: 0, prunes: 2, stamps: 2, maxToolResults: 5, maxKeptBytes: 900, savedBytes: 4000, lastPruned: 3 });
  });

  it("counts error records, unknown kinds and unparsable lines as errors, never as success", () => {
    const state = parseHistoryState([line({ kind: "error", message: "x" }), "not json", line({ kind: "mystery" }), "[1]", ""].join("\n"));
    expect(state).toMatchObject({ errors: 4, prunes: 0, loaded: false });
  });

  it("ignores negative or non-numeric counters", () => {
    expect(parseHistoryState(line({ kind: "prune", toolResults: -4, keptBytes: "9", savedBytes: null }))).toMatchObject({ prunes: 1, maxToolResults: 0, maxKeptBytes: 0, savedBytes: 0 });
  });

  it("reads an empty file as nothing having happened", () => {
    expect(parseHistoryState("")).toEqual(EMPTY_HISTORY_STATE);
  });
});

describe("readHistoryState", () => {
  it("reads a state file and treats a missing file as 'the plugin never ran'", () => {
    const dir = mkdtempSync(join(tmpdir(), "cra-hs-"));
    const file = join(dir, "state.jsonl");
    expect(readHistoryState(file)).toEqual(EMPTY_HISTORY_STATE);
    writeFileSync(file, `${line({ kind: "loaded" })}\n`);
    expect(readHistoryState(file)).toMatchObject({ loaded: true });
  });
});
