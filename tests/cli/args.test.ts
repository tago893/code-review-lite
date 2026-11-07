import { describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.js";

const ok = (argv: string[]) => {
  const r = parseArgs(argv);
  if (!r.ok) throw new Error(r.error);
  return r.command;
};
const err = (argv: string[]) => {
  const r = parseArgs(argv);
  if (r.ok) throw new Error("expected an error");
  return r.error;
};

describe("parseArgs", () => {
  it("parses prepare with an optional --diff", () => {
    const base = ["prepare", "--repo", "/r", "--base", "main", "--head", "feat", "--out-repo", "/o/repo", "--out-ctx", "/o/ctx"];
    expect(ok(base)).toEqual({ kind: "prepare", repo: "/r", base: "main", head: "feat", outRepo: "/o/repo", outCtx: "/o/ctx" });
    expect(ok([...base, "--diff", "d.patch"])).toMatchObject({ diff: "d.patch" });
  });

  it("parses review and defaults the log next to the report", () => {
    expect(ok(["review", "--repo", "/repo", "--ctx", "/ctx", "--prompts", "/p", "--out", "/out/report.md"])).toEqual({
      kind: "review", repo: "/repo", ctx: "/ctx", prompts: "/p", out: "/out/report.md", log: "/out/run.jsonl",
    });
    expect(ok(["review", "--repo", "/repo", "--ctx", "/ctx", "--prompts", "/p", "--out", "r.md", "--log", "x.jsonl"])).toMatchObject({ log: "x.jsonl" });
  });

  it("rejects a missing or unknown subcommand, unknown and repeated flags, and missing values", () => {
    expect(err([])).toContain("usage");
    expect(err(["run"])).toContain("usage");
    expect(err(["prepare", "--nope", "x"])).toContain("unknown option");
    expect(err(["review", "--repo", "a", "--repo", "b"])).toContain("repeated");
    expect(err(["review", "--repo"])).toContain("missing value");
    expect(err(["review", "--repo", "--ctx"])).toContain("missing value");
    expect(err(["prepare", "--repo", "/r"])).toContain("requires");
    expect(err(["review", "--base", "x"])).toContain("unknown option");
  });
});
