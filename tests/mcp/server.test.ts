import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { APPROVED_TOOL_IDS, SERVER_NAME, TOOLS, handleRequest, type RpcResponse } from "../../src/mcp/server.js";
import type { Roots } from "../../src/mcp/paths.js";

let base = "";
let roots: Roots;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "mcps-"));
  mkdirSync(join(base, "repo/src"), { recursive: true });
  mkdirSync(join(base, "ctx"));
  writeFileSync(join(base, "repo/src/a.ts"), "export const a = 1;\n");
  roots = { primary: join(base, "repo"), extra: [join(base, "ctx")] };
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const call = (name: string, args: unknown): Promise<RpcResponse | undefined> =>
  handleRequest(roots, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });
const textOf = (r: RpcResponse | undefined): string => (r?.result as { content: { text: string }[] }).content[0]?.text ?? "";

describe("MCP server protocol", () => {
  it("offers exactly the four approved read-only tools, and their OpenCode ids match the approved list", async () => {
    const listed = await handleRequest(roots, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (listed?.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(["read", "grep", "glob", "list"]);
    expect(names.map((n) => `${SERVER_NAME}_${n}`)).toEqual([...APPROVED_TOOL_IDS]);
    expect(TOOLS).toHaveLength(4);
  });

  it("answers initialize and ping, and says nothing to notifications", async () => {
    const init = await handleRequest(roots, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(init?.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cra" } });
    expect((await handleRequest(roots, { jsonrpc: "2.0", id: 2, method: "ping" }))?.result).toEqual({});
    expect(await handleRequest(roots, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
  });

  it("rejects unknown methods and unknown tools", async () => {
    expect((await handleRequest(roots, { jsonrpc: "2.0", id: 3, method: "resources/list" }))?.error?.code).toBe(-32601);
    expect((await call("bash", { command: "id" }))?.error?.code).toBe(-32602);
    expect((await call("write", { path: "x", content: "y" }))?.error?.code).toBe(-32602);
  });

  it("runs a tool and returns text", async () => {
    expect(textOf(await call("read", { path: "src/a.ts" }))).toContain("1: export const a = 1;");
  });

  it("reports a refusal as a tool error without leaking file content or host paths", async () => {
    writeFileSync(join(base, "secret.txt"), "TOP-SECRET-CONTENT\n");
    const r = await call("read", { path: "../secret.txt" });
    expect((r?.result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toBe("error (outside_roots): path is outside the repository snapshot and the review context");
    expect(textOf(r)).not.toContain(base);
    const bad = await call("read", { path: "src/a.ts", offset: -1 });
    expect(textOf(bad)).toMatch(/^error \(bad_arguments\):/);
  });

  it("never throws, whatever it is sent", async () => {
    for (const request of [{ id: 1, method: "tools/call" }, { id: 2, method: "tools/call", params: { name: "read" } }, { id: 3, method: "tools/call", params: { name: "grep", arguments: null } }]) {
      await expect(handleRequest(roots, { jsonrpc: "2.0", ...request } as never)).resolves.toBeDefined();
    }
  });
});
