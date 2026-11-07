import { describe, expect, it } from "vitest";
import { assessRiskTier } from "../../src/risk/tier.js";
import { entry, excluded, lines } from "./helpers.js";

describe("assessRiskTier: the plan's exact rules", () => {
  it("a 1-line diff adding string-built SQL is full", () => {
    const e = entry({ newPath: "src/users.ts", addedLines: ['db.query("SELECT * FROM users WHERE id = " + userId);'] });
    const result = assessRiskTier([e]);
    expect(result.tier).toBe("full");
    expect(result.agents).toEqual(["code_quality", "security", "performance"]);
    expect(result.reasons.join(" ")).toMatch(/SQL/);
  });

  it("a 1-line removal of an admin check is full", () => {
    const e = entry({ newPath: "src/api.ts", addedLines: [], removedLines: ["if (!user.isAdmin) return;"] });
    expect(assessRiskTier([e]).tier).toBe("full");
  });

  it("a 1-line README edit is trivial with only code_quality", () => {
    const result = assessRiskTier([entry({ newPath: "README.md", addedLines: ["Fixed a typo."] })]);
    expect(result).toMatchObject({ tier: "trivial", agents: ["code_quality"] });
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("60 changed lines across 3 plain files is lite with code_quality and security", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"].map((newPath) => entry({ newPath, addedLines: lines(20) }));
    const result = assessRiskTier(files);
    expect(result).toMatchObject({ tier: "lite", agents: ["code_quality", "security"] });
  });

  it("a file under auth/ forces full", () => {
    const result = assessRiskTier([entry({ newPath: "src/auth/login.ts", addedLines: ["// comment"] })]);
    expect(result.tier).toBe("full");
  });

  it("deleting a test file, or adding .skip(, forces full", () => {
    const deleted = entry({ newPath: "tests/a.test.ts", status: "deleted", addedLines: [], removedLines: lines(3) });
    const skipped = entry({ newPath: "tests/a.test.ts", addedLines: ['describe.skip("a", () => {});'] });
    expect(assessRiskTier([deleted]).tier).toBe("full");
    expect(assessRiskTier([skipped]).tier).toBe("full");
  });

  it("every forced tier has non-empty reasons that name the file", () => {
    const e = entry({ newPath: "src/auth/login.ts" });
    const result = assessRiskTier([e]);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.join(" ")).toContain("src/auth/login.ts");
  });
});

describe("assessRiskTier: size floor", () => {
  const plain = (count: number, fileCount = 1) =>
    Array.from({ length: fileCount }, (_, i) =>
      entry({ newPath: `src/f${i}.ts`, addedLines: lines(Math.ceil(count / fileCount)) }),
    );

  it.each([
    [10, 1, "trivial"],
    [11, 1, "lite"],
    [100, 1, "lite"],
    [101, 1, "full"],
  ] as const)("%i changed lines in %i file is %s", (count, fileCount, tier) => {
    expect(assessRiskTier(plain(count, fileCount)).tier).toBe(tier);
  });

  it("counts removed lines as well as added lines", () => {
    const e = entry({ newPath: "src/a.ts", addedLines: lines(6), removedLines: lines(6) });
    expect(assessRiskTier([e]).tier).toBe("lite");
  });

  it("more than 20 files is at least full", () => {
    expect(assessRiskTier(plain(21, 21)).tier).toBe("full");
  });

  it("an empty change is trivial and says so", () => {
    const result = assessRiskTier([]);
    expect(result.tier).toBe("trivial");
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe("assessRiskTier: size is a floor, signals only raise", () => {
  it("separates the size floor from the behavior tier, so a large plain diff is not called risky", () => {
    const big = entry({ newPath: "src/big.ts", addedLines: lines(300) });
    const result = assessRiskTier([big]);
    expect(result.tier).toBe("full");
    expect(result.floorTier).toBe("full");
    expect(result.signalTier).toBe("trivial");
    expect(result.signals).toEqual([]);
    expect(result.reasons.join(" ")).toMatch(/size/i);
  });

  it("never lowers the tier below the size floor", () => {
    const e = entry({ newPath: "src/auth/a.ts", addedLines: lines(150) });
    expect(assessRiskTier([e])).toMatchObject({ tier: "full", floorTier: "full", signalTier: "full" });
  });

  it("a tiny change with a signal is full while its floor is trivial", () => {
    const e = entry({ newPath: "src/x.ts", addedLines: ["eval(input);"] });
    expect(assessRiskTier([e])).toMatchObject({ tier: "full", floorTier: "trivial", signalTier: "full" });
  });
});

describe("assessRiskTier: several categories, excluded files and uncertainty", () => {
  it("returns every signal, from several families", () => {
    const e = entry({
      newPath: "src/auth/session.ts",
      addedLines: ['db.query("SELECT * FROM s WHERE id = " + id);', "let active = 0;"],
    });
    const result = assessRiskTier([e]);
    expect(new Set(result.signals.map((s) => s.family)).size).toBeGreaterThanOrEqual(3);
    expect(result.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("uses excluded-file metadata: an excluded lockfile forces full even with no kept files", () => {
    const result = assessRiskTier([], [excluded({ path: "package-lock.json", kind: "lockfile" })]);
    expect(result.tier).toBe("full");
    expect(result.reasons.join(" ")).toContain("package-lock.json");
  });

  it("records uncertainty for files whose behavior cannot be judged, without raising the tier", () => {
    const result = assessRiskTier(
      [],
      [
        excluded({ path: "assets/logo.png", kind: "binary" }),
        excluded({ path: "src/gen/api.ts", kind: "generated" }),
        excluded({ path: "dist/app.min.js", kind: "bundled_asset" }),
      ],
    );
    expect(result.tier).toBe("trivial");
    expect(result.uncertainties).toHaveLength(3);
    expect(result.uncertainties.join(" ")).toMatch(/logo\.png/);
    expect(result.uncertainties.join(" ")).toMatch(/not analy[sz]ed/i);
  });

  it("records uncertainty for a kept change that has no visible lines", () => {
    const modeOnly = entry({ newPath: "scripts/run.sh", addedLines: [], removedLines: [] });
    const binaryKept = entry({ newPath: "a.bin", isBinary: true, addedLines: [], removedLines: [] });
    const result = assessRiskTier([modeOnly, binaryKept]);
    expect(result.uncertainties.join(" ")).toContain("scripts/run.sh");
    expect(result.uncertainties.join(" ")).toContain("a.bin");
  });

  it("reports the measured size", () => {
    const e = entry({ newPath: "src/a.ts", addedLines: lines(4), removedLines: lines(2) });
    expect(assessRiskTier([e]).size).toEqual({ changedLines: 6, files: 1 });
  });

  it("is deterministic and returns frozen results", () => {
    const input = Object.freeze([entry({ newPath: "src/auth/a.ts" })]);
    const first = assessRiskTier(input);
    expect(assessRiskTier(input)).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.reasons)).toBe(true);
    expect(Object.isFrozen(first.agents)).toBe(true);
  });
});
