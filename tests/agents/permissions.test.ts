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

  it("allows exactly the four bounded MCP tools and denies OpenCode's own read, grep, glob and list", () => {
    const candidates = ["cra_read", "cra_grep", "cra_glob", "cra_list", "read", "grep", "glob", "list", "edit", "write", "patch", "bash", "webfetch", "task", "cra_write", "cra_bash", "x", "*"];
    expect(candidates.filter((tool) => p.isAllowed(tool)).sort()).toEqual(["cra_glob", "cra_grep", "cra_list", "cra_read"]);
    expect([...p.allowedTools].sort()).toEqual(["cra_glob", "cra_grep", "cra_list", "cra_read"]);
  });

  it("denies by default and fences everything outside the workspace except the sanitised context", () => {
    expect(p.permission["*"]).toBe("deny");
    expect(p.permission["external_directory"]).toEqual({ "*": "deny" });
  });

  it("denies the built-in read tool outright; env files are withheld by the bounded cra_read tool instead", () => {
    expect(p.permission["read"]).toBe("deny");
    expect(p.permission["cra_read"]).toBe("allow");
  });

  it("is frozen and carries the repo root", () => {
    expect(Object.isFrozen(p)).toBe(true);
    expect(p.repoRoot).toBe("/repo");
  });

  it.each(["", "relative/path", "/", "/repo/../etc", "/repo\0x"])("rejects the unsafe root %j", (root) => {
    expect(() => buildAgentPermissions(root)).toThrow();
  });
});
