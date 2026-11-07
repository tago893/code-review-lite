import { describe, expect, it } from "vitest";
import { buildAgentPermissions } from "../../src/agents/permissions.js";

describe("buildAgentPermissions", () => {
  const p = buildAgentPermissions("/repo");

  it.each(["edit", "write", "patch", "bash", "webfetch", "websearch", "task", "todowrite", "skill", "question", "lsp", "doom_loop", "multiedit", "anything_new"])(
    "denies %s",
    (tool) => {
      expect(p.isAllowed(tool)).toBe(false);
    },
  );

  it("allows exactly read, grep, glob and list", () => {
    const candidates = ["read", "grep", "glob", "list", "edit", "write", "patch", "bash", "webfetch", "task", "x", "*"];
    expect(candidates.filter((tool) => p.isAllowed(tool)).sort()).toEqual(["glob", "grep", "list", "read"]);
    expect([...p.allowedTools].sort()).toEqual(["glob", "grep", "list", "read"]);
  });

  it("denies by default and fences everything outside the workspace except the sanitised context", () => {
    expect(p.permission["*"]).toBe("deny");
    expect(p.permission["external_directory"]).toEqual({ "*": "deny", "/review/context/**": "allow" });
  });

  it("denies reading env files even inside the workspace", () => {
    expect(p.permission["read"]).toMatchObject({ "*.env": "deny", "*.env.*": "deny" });
  });

  it("is frozen and carries the repo root", () => {
    expect(Object.isFrozen(p)).toBe(true);
    expect(p.repoRoot).toBe("/repo");
  });

  it.each(["", "relative/path", "/", "/repo/../etc", "/repo\0x"])("rejects the unsafe root %j", (root) => {
    expect(() => buildAgentPermissions(root)).toThrow();
  });
});
