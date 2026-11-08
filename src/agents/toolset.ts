import { TOOLING_MARKER } from "../resilience/errors.js";
import { APPROVED_TOOL_IDS, SERVER_NAME } from "../mcp/ids.js";

/** What OpenCode reports about the tools it has registered. */
export interface ToolsetApi {
  /** MCP servers by name, with their connection status. */
  mcpStatus(): Promise<Readonly<Record<string, { readonly status?: string }>>>;
  /** Every registered tool id: built-in and dynamically registered. */
  toolIds(): Promise<readonly string[]>;
}

/**
 * The tool ids OpenCode 1.19.5 registers by itself (measured). They are all denied by the permission table; this list
 * exists so that any OTHER id (a tool some configuration registered) is noticed. A different OpenCode version may add
 * ids; the check then fails closed until the list is reviewed.
 */
export const KNOWN_BUILTIN_TOOL_IDS: ReadonlySet<string> = new Set([
  "invalid", "question", "bash", "read", "glob", "grep", "edit", "write", "task", "webfetch", "todowrite", "websearch", "skill", "apply_patch",
]);

export interface ToolsetTiming {
  readonly waitMs: number;
  readonly pollMs: number;
}

export class ToolsetVerificationError extends Error {
  readonly code = TOOLING_MARKER;

  constructor(reason: string) {
    super(`reviewer toolset could not be verified: ${reason}`);
    this.name = "ToolsetVerificationFailed";
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Confirms, before any review starts, that CRA's own MCP server is the only MCP server and is connected, and that
 * OpenCode registers no tool beyond its known built-ins (all denied by the permission table). OpenCode 1.19.5 does not
 * list MCP tools in tool.ids (measured), so the four bounded tools are not asserted here: the server's tool list is
 * fixed in code and unit-tested, and the integration suite checks the tool names a model is actually offered. Anything
 * else throws, and the review ends incomplete: there is no fall back to OpenCode's
 * unbounded built-in tools. Reasons are fixed words, never server output.
 */
export async function verifyToolset(api: ToolsetApi, timing: ToolsetTiming, sleep: (ms: number) => Promise<void> = realSleep): Promise<void> {
  let waited = 0;
  let servers: Readonly<Record<string, { readonly status?: string }>> = {};
  for (;;) {
    servers = await api.mcpStatus().catch(() => ({}));
    const status = servers[SERVER_NAME]?.status;
    if (status === "connected") break;
    if (status === "failed" || waited >= timing.waitMs) throw new ToolsetVerificationError(`mcp_server_${status ?? "absent"}`);
    await sleep(timing.pollMs);
    waited += timing.pollMs;
  }
  if (Object.keys(servers).some((name) => name !== SERVER_NAME)) throw new ToolsetVerificationError("unexpected_mcp_server");

  const ids = await api.toolIds().catch(() => undefined);
  if (ids === undefined) throw new ToolsetVerificationError("tool_list_unavailable");
  if (ids.some((id) => !KNOWN_BUILTIN_TOOL_IDS.has(id) && !APPROVED_TOOL_IDS.includes(id))) throw new ToolsetVerificationError("unexpected_tool_registered");
}
