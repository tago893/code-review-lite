import { describe, expect, it } from "vitest";
import { buildDiffContext } from "../../src/workspace/context.js";
import { gateForModel } from "../../src/workspace/gate.js";
import { reviewerPermission } from "../../src/workspace/permissions.js";
import { fake, filler } from "../safety/fakes.js";

const section = (path: string, added: string[]): string =>
  [
    `diff --git a/${path} b/${path}`, "new file mode 100644", "index 0000000..1111111", "--- /dev/null", `+++ b/${path}`,
    `@@ -0,0 +1,${added.length} @@`, ...added.map((l) => `+${l}`), "",
  ].join("\n");

describe("buildDiffContext", () => {
  it("redacts secrets and withholds the content of sensitive files but still lists them", () => {
    const pw = fake.password();
    const envValue = filler(30);
    const diff = section("src/db.ts", [`const password = "${pw}";`]) + section(".env", [`TOKEN=${envValue}`]) + section("deploy/a.pem", [filler(64)]);
    const ctx = buildDiffContext(diff);
    expect(ctx.patch).toContain('const password = "[REDACTED]";');
    expect(ctx.patch).not.toContain(pw);
    expect(ctx.patch).not.toContain(envValue);
    expect(ctx.patch).not.toContain(filler(64));
    expect(ctx.withheld).toEqual([".env", "deploy/a.pem"]);
    expect(ctx.files).toBe(1);
  });

  it("raises a fixed-message error for an unparsable diff without echoing it", () => {
    const secret = fake.groq();
    let message = "";
    try {
      buildDiffContext(`diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ garbage ${secret}\n`);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toMatch(/diff_parse_failed/);
    expect(message).not.toContain(secret);
  });
});

describe("gateForModel", () => {
  it("passes redacted text for both stages", () => {
    const note = `src/a.ts:2: password = "${fake.password()}"`;
    for (const stage of ["phase1_context", "phase2_notes"] as const) {
      const result = gateForModel(stage, note);
      expect(result.status).toBe("ok");
      if (result.status === "ok") expect(result.text).toBe('src/a.ts:2: password = "[REDACTED]"');
    }
  });

  it("returns incomplete, with no text, when sanitising is not possible", () => {
    const result = gateForModel("phase2_notes", undefined as unknown as string);
    expect(result).toEqual({ status: "incomplete", stage: "phase2_notes", reason: "invalid_input" });
  });
});

describe("reviewerPermission", () => {
  const p = reviewerPermission();

  it("denies everything by default and every write, exec and network tool", () => {
    expect(p["*"]).toBe("deny");
    for (const tool of ["edit", "bash", "webfetch", "websearch", "task", "todowrite", "skill", "question", "lsp", "doom_loop"]) {
      expect(p[tool]).toBe("deny");
    }
  });

  it("denies OpenCode's own file tools and allows only the bounded MCP tools", () => {
    expect([p["read"], p["grep"], p["glob"], p["list"]]).toEqual(["deny", "deny", "deny", "deny"]);
    expect([p["cra_read"], p["cra_grep"], p["cra_glob"], p["cra_list"]]).toEqual(["allow", "allow", "allow", "allow"]);
    expect(p["external_directory"]).toEqual({ "*": "deny" });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(p)).toBe(true);
  });
});
