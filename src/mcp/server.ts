import { createInterface } from "node:readline";
import { ZodError } from "zod";
import { CONTEXT_ROOT, REPO_ROOT } from "../workspace/permissions.js";
import { APPROVED_TOOL_IDS, SERVER_NAME } from "./ids.js";
import { ToolError, type Roots } from "./paths.js";
import { globTool, grepTool, listTool, readTool } from "./tools.js";

// A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0) that OpenCode starts as a local child process.
// It offers four read-only tools and nothing else. It reads only under the configured roots, never executes
// repository content, and holds no credentials or network access of its own (it runs in the agent container).

export { APPROVED_TOOL_IDS, SERVER_NAME };

interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly run: (roots: Roots, args: unknown) => string | Promise<string>;
}

const PATH_NOTE = "Paths are relative to the repository root, or absolute under /repo or /review/context.";

export const TOOLS: readonly ToolSpec[] = Object.freeze([
  {
    name: "read",
    description: `Read a text file. Returns at most 100 lines (200 with limit) starting at \`offset\` (1-based), each prefixed with its real line number. Large files are returned in chunks: when the result ends with [TRUNCATED ...], call read again with the offset it gives. ${PATH_NOTE}`,
    inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1 } }, required: ["path"] },
    run: readTool,
  },
  {
    name: "grep",
    description: `Search file contents with a regular expression (or a literal with literal=true). Returns at most 40 matching lines as path:line: text. Use it to find callers and definitions across files, then read the lines you need. Optional path (file or directory) and include glob. ${PATH_NOTE}`,
    inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" }, literal: { type: "boolean" } }, required: ["pattern"] },
    run: grepTool,
  },
  {
    name: "glob",
    description: `Find files by glob pattern such as src/**/*.ts. Returns at most 100 paths. Optional path (directory). ${PATH_NOTE}`,
    inputSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    run: globTool,
  },
  {
    name: "list",
    description: `List one directory level (at most 100 entries; directories end with /). ${PATH_NOTE}`,
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    run: listTool,
  },
]);

export interface RpcRequest {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface RpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

const text = (value: string, isError = false) => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });

/** Handles one request. Returns undefined for notifications, which get no reply. Never throws. */
export async function handleRequest(roots: Roots, request: RpcRequest): Promise<RpcResponse | undefined> {
  const id = request.id;
  if (id === undefined || id === null) return undefined;
  const ok = (result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (request.method) {
    case "initialize":
      return ok({ protocolVersion: typeof request.params?.["protocolVersion"] === "string" ? request.params["protocolVersion"] : "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: "1" } });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const name = request.params?.["name"];
      const tool = TOOLS.find((t) => t.name === name);
      if (tool === undefined) return fail(-32602, "unknown tool");
      try {
        return ok(text(await tool.run(roots, request.params?.["arguments"] ?? {})));
      } catch (error) {
        return ok(text(describe(error), true));
      }
    }
    default:
      return fail(-32601, "method not found");
  }
}

/** A short, content-free description of a failure. */
function describe(error: unknown): string {
  if (error instanceof ToolError) return `error (${error.code}): ${error.message}`;
  if (error instanceof ZodError) return `error (bad_arguments): ${error.issues.map((i) => `${i.path.join(".") || "arguments"} ${i.message}`).join("; ")}`;
  return "error (failed): the tool failed";
}

function main(): void {
  const roots: Roots = { primary: process.env["CRA_MCP_ROOT"] ?? REPO_ROOT, extra: [process.env["CRA_MCP_CONTEXT"] ?? CONTEXT_ROOT] };
  const write = (response: RpcResponse): void => { process.stdout.write(`${JSON.stringify(response)}\n`); };
  createInterface({ input: process.stdin }).on("line", (line) => {
    let request: RpcRequest;
    try {
      request = JSON.parse(line) as RpcRequest;
    } catch {
      return;
    }
    void handleRequest(roots, request).then((response) => { if (response) write(response); });
  });
}

if (process.argv[1]?.endsWith("server.js")) main();
