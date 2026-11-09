import { TOOLS } from "../../src/mcp/server.js";
import { ToolError, type Roots } from "../../src/mcp/paths.js";

// The four read-only tools, exactly as the MCP server runs them (same path containment, symlink refusal, withheld files,
// output limits). Only the wrapper is new: model-facing names are cra_read, cra_grep, cra_glob and cra_list, and a call
// is classified before it runs. There is no other tool, so there is nothing that can write, execute or reach a network.

const PREFIX = "cra_";
const NAME_SHAPE = /^[a-z][a-z0-9_]{0,40}$/;
const MAX_ARGUMENT_CHARS = 4_000;

/** The model produced a call that cannot be a tool call at all (garbled name, arguments that are not a JSON object). */
export class MalformedToolCall extends Error {
  constructor(readonly code: "bad_tool_name" | "bad_arguments") {
    super(`malformed_tool_call_${code}`);
    this.name = "MalformedToolCall";
  }
}

export interface ToolOutcome {
  readonly output: string;
  /** "ok", or a fixed word: unknown_tool, invalid_arguments, or the ToolError code (outside_roots, withheld, ...). */
  readonly status: string;
}

export const toolDefinitions = Object.freeze(
  TOOLS.map((t) => Object.freeze({ type: "function" as const, function: { name: PREFIX + t.name, description: t.description, parameters: t.inputSchema } })),
);

/**
 * Runs one model-requested call. A garbled name or non-object arguments throw MalformedToolCall (the loop ends the run);
 * a well-formed request for something forbidden (another tool, a path outside the snapshot) comes back as an error result
 * the model can read, and the run goes on. Never returns file content in an error.
 */
export async function runTool(roots: Roots, name: string, rawArguments: string): Promise<ToolOutcome> {
  if (!NAME_SHAPE.test(name)) throw new MalformedToolCall("bad_tool_name");
  const args = parseArguments(rawArguments);
  const tool = TOOLS.find((t) => PREFIX + t.name === name);
  if (tool === undefined) return Object.freeze({ output: `error: unknown_tool. Available tools: ${TOOLS.map((t) => PREFIX + t.name).join(", ")}.`, status: "unknown_tool" });
  try {
    return Object.freeze({ output: await tool.run(roots, args), status: "ok" });
  } catch (error) {
    const status = error instanceof ToolError ? error.code : "invalid_arguments";
    return Object.freeze({ output: `error: ${status}${error instanceof ToolError ? `. ${error.message}` : ""}`, status });
  }
}

function parseArguments(raw: string): unknown {
  if (raw.length > MAX_ARGUMENT_CHARS) throw new MalformedToolCall("bad_arguments");
  try {
    const parsed: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new MalformedToolCall("bad_arguments");
    return parsed;
  } catch (error) {
    throw error instanceof MalformedToolCall ? error : new MalformedToolCall("bad_arguments");
  }
}
