import { TOOLS } from "../../src/mcp/server.js";
import { ToolError, type Roots } from "../../src/mcp/paths.js";

// The four read-only tools, exactly as the MCP server runs them (same path containment, symlink refusal, withheld files,
// output limits). Only the wrapper is new: model-facing names are cra_read, cra_grep, cra_glob and cra_list. There is no
// other tool, so there is nothing that can write, execute or reach a network.
//
// A bad call never ends the review here: a made-up tool name or arguments that are not a JSON object come back to the
// model as a fixed error result (the loop counts them and stops a model that keeps doing it). The error never copies the
// model's name or arguments, so nothing model-written is echoed back or logged.

const PREFIX = "cra_";
const MAX_ARGUMENT_CHARS = 4_000;
const NAMES = TOOLS.map((t) => PREFIX + t.name);
const UNKNOWN_TOOL = `error: unknown_tool. That tool does not exist. The only tools are ${NAMES.join(", ")}; call one of them by its exact name.`;
const UNPARSABLE = 'error: unparsable_arguments. The arguments must be one JSON object, for example {"path": "src/app.ts"}.';

export interface ToolOutcome {
  readonly output: string;
  /** "ok", or a fixed word: unknown_tool, unparsable_arguments, invalid_arguments, or the ToolError code (outside_roots, withheld, ...). */
  readonly status: string;
}

/** Statuses the loop counts against the per-run limit of rejected calls. */
export const REJECTED_CALL_STATUSES: ReadonlySet<string> = new Set(["unknown_tool", "unparsable_arguments"]);

export const toolDefinitions = Object.freeze(
  TOOLS.map((t) => Object.freeze({ type: "function" as const, function: { name: PREFIX + t.name, description: t.description, parameters: t.inputSchema } })),
);

/**
 * The tool name as it may appear in the trace: one of the four real names, or a fixed classification of a name that does
 * not exist. Never the name itself, which is model output.
 */
export function toolLabel(name: string): string {
  if (NAMES.includes(name)) return name;
  if (name.length > 80) return "unknown:garbled";
  if (/^repo_browser\b/.test(name)) return "unknown:repo_browser";
  if (/^container\./.test(name)) return "unknown:container";
  if (/^functions\./.test(name)) return "unknown:functions_prefix";
  if (/^cra_(?:read|grep|glob|list)/.test(name)) return "unknown:garbled_cra";
  if (/^[a-z_][a-z0-9_]{0,40}$/.test(name)) return "unknown:plain";
  if (/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(name)) return "unknown:dotted";
  return "unknown:garbled";
}

/** Runs one model-requested call. Never throws, and never returns file content in an error. */
export async function runTool(roots: Roots, name: string, rawArguments: string): Promise<ToolOutcome> {
  const tool = TOOLS.find((t) => PREFIX + t.name === name);
  if (tool === undefined) return Object.freeze({ output: UNKNOWN_TOOL, status: "unknown_tool" });
  const args = parseArguments(rawArguments);
  if (args === undefined) return Object.freeze({ output: UNPARSABLE, status: "unparsable_arguments" });
  try {
    return Object.freeze({ output: await tool.run(roots, args), status: "ok" });
  } catch (error) {
    const status = error instanceof ToolError ? error.code : "invalid_arguments";
    return Object.freeze({ output: `error: ${status}${error instanceof ToolError ? `. ${error.message}` : ""}`, status });
  }
}

/** The arguments as a JSON object, or undefined when they are too long, not JSON, or not an object. */
function parseArguments(raw: string): object | undefined {
  if (raw.length > MAX_ARGUMENT_CHARS) return undefined;
  try {
    const parsed: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
