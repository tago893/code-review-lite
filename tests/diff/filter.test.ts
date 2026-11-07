import { describe, expect, it } from "vitest";
import { DEFAULT_FILTER_OPTIONS, filterNoise } from "../../src/diff/filter.js";
import { parseUnifiedDiff } from "../../src/diff/parse.js";
import type { DiffEntry } from "../../src/types.js";

function entry(overrides: Partial<DiffEntry> & { newPath: string }): DiffEntry {
  return {
    oldPath: overrides.newPath,
    status: "added",
    addedLines: ["const x = 1;"],
    removedLines: [],
    addedLineNumbers: [1],
    removedLineNumbers: [],
    isBinary: false,
    isRename: false,
    patch: "",
    ...overrides,
  };
}

const reasonFor = (result: ReturnType<typeof filterNoise>, path: string) =>
  result.removed.find((item) => item.path === path)?.reason;

describe("filterNoise: files removed by name", () => {
  it("removes lockfiles, minified assets and source maps, each with a reason", () => {
    const entries = ["package-lock.json", "app.min.js", "app.js.map", "keep.ts"].map((newPath) => entry({ newPath }));
    const result = filterNoise(entries);
    expect(result.kept.map((e) => e.newPath)).toEqual(["keep.ts"]);
    expect(reasonFor(result, "package-lock.json")).toMatch(/lockfile/i);
    expect(reasonFor(result, "app.min.js")).toMatch(/\.min\.js/);
    expect(reasonFor(result, "app.js.map")).toMatch(/\.map/);
  });

  it("matches lockfiles by basename in any directory and extensions case-insensitively", () => {
    const result = filterNoise([entry({ newPath: "packages/web/yarn.lock" }), entry({ newPath: "dist/APP.MIN.CSS" })]);
    expect(result.kept).toEqual([]);
    expect(result.removed).toHaveLength(2);
  });

  it("covers every lockfile named in the plan", () => {
    const names = ["bun.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock", "go.sum", "poetry.lock", "Pipfile.lock", "flake.lock"];
    expect(filterNoise(names.map((newPath) => entry({ newPath }))).kept).toEqual([]);
  });
});

describe("filterNoise: generated-file markers", () => {
  it("removes an added file starting with // @generated, naming the marker", () => {
    const generated = entry({ newPath: "src/api.ts", addedLines: ["// @generated", "export const a = 1;"] });
    const result = filterNoise([generated]);
    expect(result.kept).toEqual([]);
    expect(reasonFor(result, "src/api.ts")).toMatch(/@generated/);
  });

  it("does not treat eslint-disable as proof that a file is generated", () => {
    const handWritten = entry({ newPath: "a.js", addedLines: ["/* eslint-disable no-console */", "run();"] });
    expect(DEFAULT_FILTER_OPTIONS.generatedMarkers).not.toContain("eslint-disable");
    expect(filterNoise([handWritten]).kept).toEqual([handWritten]);
  });

  it("still allows eslint-disable to be configured as a marker by the caller", () => {
    const e = entry({ newPath: "a.js", addedLines: ["/* eslint-disable */"] });
    expect(filterNoise([e], { generatedMarkers: ["eslint-disable"] }).kept).toEqual([]);
  });

  it("keeps the same marker in a database migration", () => {
    const migration = entry({ newPath: "db/migrations/001.sql", addedLines: ["-- @generated", "CREATE TABLE t (id int);"] });
    expect(filterNoise([migration]).kept).toEqual([migration]);
  });

  it("only looks at the first lines of the file", () => {
    const lines = [...Array.from({ length: 30 }, () => "x"), "// @generated"];
    expect(filterNoise([entry({ newPath: "late.ts", addedLines: lines })]).kept).toHaveLength(1);
  });

  it("sees a header that appears as context in a modified file's first hunk", () => {
    const text = [
      "diff --git a/gen.ts b/gen.ts",
      "--- a/gen.ts",
      "+++ b/gen.ts",
      "@@ -1,3 +1,3 @@",
      " // @generated",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "",
    ].join("\n");
    const result = filterNoise(parseUnifiedDiff(text));
    expect(result.kept).toEqual([]);
    expect(reasonFor(result, "gen.ts")).toMatch(/@generated/);
  });

  it("keeps a modified file whose header is outside the visible hunk", () => {
    const text = "diff --git a/g.ts b/g.ts\n--- a/g.ts\n+++ b/g.ts\n@@ -40,1 +40,1 @@\n-a\n+b\n";
    expect(filterNoise(parseUnifiedDiff(text)).kept).toHaveLength(1);
  });
});

describe("filterNoise: files with nothing to review", () => {
  it("removes binary files and pure renames, with reasons", () => {
    const binary = entry({ newPath: "logo.png", isBinary: true, addedLines: [], addedLineNumbers: [] });
    const renamed = entry({
      newPath: "b.ts", oldPath: "a.ts", status: "renamed", isRename: true, addedLines: [], addedLineNumbers: [],
    });
    const result = filterNoise([binary, renamed]);
    expect(result.kept).toEqual([]);
    expect(reasonFor(result, "logo.png")).toMatch(/binary/i);
    expect(reasonFor(result, "b.ts")).toMatch(/rename/i);
  });

  it("keeps a rename that also changes lines", () => {
    const edited = entry({ newPath: "b.ts", oldPath: "a.ts", status: "renamed", isRename: true });
    expect(filterNoise([edited]).kept).toEqual([edited]);
  });

  it("can be told to keep binary files and renames", () => {
    const binary = entry({ newPath: "logo.png", isBinary: true, addedLines: [], addedLineNumbers: [] });
    expect(filterNoise([binary], { dropBinary: false }).kept).toEqual([binary]);
  });
});

describe("filterNoise: excluded-file metadata for downstream stages", () => {
  it("keeps structured metadata so an excluded change is never invisible", () => {
    const lock = entry({
      newPath: "package-lock.json", status: "modified", addedLines: ["a", "b"], removedLines: ["c"],
    });
    const { removed } = filterNoise([lock]);
    expect(removed).toEqual([
      {
        path: "package-lock.json",
        oldPath: "package-lock.json",
        status: "modified",
        kind: "lockfile",
        reason: "lockfile (package-lock.json)",
        addedLineCount: 2,
        removedLineCount: 1,
      },
    ]);
  });

  it("reports the old path for a renamed excluded file and a kind for each rule", () => {
    const renamed = entry({
      newPath: "b.ts", oldPath: "a.ts", status: "renamed", isRename: true, addedLines: [], addedLineNumbers: [],
    });
    const binary = entry({ newPath: "x.png", isBinary: true, addedLines: [], addedLineNumbers: [] });
    const asset = entry({ newPath: "app.min.js" });
    const generated = entry({ newPath: "g.ts", addedLines: ["// @generated"] });
    const { removed } = filterNoise([renamed, binary, asset, generated]);
    expect(removed.map((r) => r.kind)).toEqual(["rename_only", "binary", "bundled_asset", "generated"]);
    expect(removed[0]!.oldPath).toBe("a.ts");
  });
});

describe("filterNoise: configuration and guarantees", () => {
  it("accepts extra lockfiles, extensions and markers", () => {
    const entries = [
      entry({ newPath: "deps.lock" }),
      entry({ newPath: "x.pb.go" }),
      entry({ newPath: "y.ts", addedLines: ["// AUTO-GENERATED"] }),
    ];
    const result = filterNoise(entries, {
      lockfileNames: ["deps.lock"],
      noisyExtensions: [".pb.go"],
      generatedMarkers: ["AUTO-GENERATED"],
    });
    expect(result.kept).toEqual([]);
    expect(result.removed).toHaveLength(3);
  });

  it("can narrow the marker scan window", () => {
    const e = entry({ newPath: "z.ts", addedLines: ["a", "b", "// @generated"] });
    expect(filterNoise([e], { markerScanLines: 2 }).kept).toHaveLength(1);
    expect(filterNoise([e], { markerScanLines: 3 }).kept).toHaveLength(0);
  });

  it("records every exclusion: kept plus removed is exactly the input", () => {
    const input = ["a.ts", "package-lock.json", "b.ts", "x.min.js"].map((newPath) => entry({ newPath }));
    const result = filterNoise(input);
    expect(result.kept.length + result.removed.length).toBe(input.length);
    expect([...result.kept.map((e) => e.newPath), ...result.removed.map((r) => r.path)].sort()).toEqual(
      input.map((e) => e.newPath).sort(),
    );
    expect(result.removed.every((item) => item.reason.length > 0)).toBe(true);
  });

  it("returns new frozen arrays and leaves the input untouched", () => {
    const input = Object.freeze([entry({ newPath: "a.ts" }), entry({ newPath: "yarn.lock" })]);
    const result = filterNoise(input);
    expect(result.kept).not.toBe(input);
    expect(input).toHaveLength(2);
    expect(Object.isFrozen(result.kept)).toBe(true);
    expect(Object.isFrozen(result.removed)).toBe(true);
  });

  it("exposes frozen defaults", () => {
    expect(Object.isFrozen(DEFAULT_FILTER_OPTIONS)).toBe(true);
    expect(DEFAULT_FILTER_OPTIONS.markerScanLines).toBeGreaterThan(0);
  });
});
