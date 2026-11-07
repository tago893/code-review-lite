import { describe, expect, it } from "vitest";
import { planReview } from "../src/plan.js";

const add = (path: string, body: string[]): string =>
  [`diff --git a/${path} b/${path}`, "new file mode 100644", "index 0000000..1111111", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`), ""].join("\n");

describe("planReview", () => {
  it("skips an empty diff", () => {
    expect(planReview("")).toMatchObject({ ok: true, plan: { disposition: "skip_clean", entries: [] } });
  });

  it("requires manual review for a lockfile-only diff and lists what was excluded", () => {
    const lock = ["diff --git a/package-lock.json b/package-lock.json", "index 1..2 100644", "--- a/package-lock.json", "+++ b/package-lock.json", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
    const planned = planReview(lock);
    expect(planned).toMatchObject({ ok: true, plan: { disposition: "manual_review" } });
    if (planned.ok) expect(planned.plan.excluded.map((x) => x.path)).toContain("package-lock.json");
  });

  it("withholds sensitive files from the entries but keeps them listed", () => {
    const planned = planReview(add(".env", ["API_KEY=abc"]) + add("src/a.ts", ["export const a = 1;"]));
    if (!planned.ok) throw new Error("expected ok");
    expect(planned.plan.entries.map((e) => e.newPath)).toEqual(["src/a.ts"]);
    expect(planned.plan.withheld).toEqual([".env"]);
    expect(planned.plan.disposition).toBe("review");
  });

  it("redacts secrets in the entries it hands to reviewers", () => {
    const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    const planned = planReview(add("src/a.ts", [`const key = "${secret}";`]));
    if (!planned.ok) throw new Error("expected ok");
    expect(JSON.stringify(planned.plan)).not.toContain(secret);
  });

  it("returns a fixed failure code, without throwing, for a diff that does not parse", () => {
    expect(planReview("this is not a diff")).toEqual({ ok: false, reason: "diff_parse_failed" });
    expect(planReview("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ garbage @@\n")).toEqual({ ok: false, reason: "diff_parse_failed" });
  });
});
