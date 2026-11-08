import { APPROVED_TOOL_IDS } from "../mcp/ids.js";
import { reviewerPermission, type PermissionRule } from "../workspace/permissions.js";

export interface AgentPermissions {
  readonly repoRoot: string;
  readonly permission: Readonly<Record<string, PermissionRule>>;
  /** The only tools an agent may use. */
  readonly allowedTools: readonly string[];
  /** Whether the permission table allows `tool`, applying the "*" default. */
  isAllowed(tool: string): boolean;
}

export const READ_TOOLS: readonly string[] = APPROVED_TOOL_IDS;

/**
 * OpenCode permissions for a reviewer working in `repoRoot`: read, grep, glob and list only, with everything else
 * (edit, write, patch, bash, web, task spawning, ...) denied by default and anything outside the workspace fenced
 * by external_directory, which allows only the sanitised context directory. This is defense in depth: the primary
 * boundary is that the agent container is only given the sanitised, read-only snapshot.
 */
export function buildAgentPermissions(repoRoot: string): AgentPermissions {
  if (!repoRoot.startsWith("/") || repoRoot === "/" || repoRoot.includes("\0") || repoRoot.split("/").includes("..")) {
    throw new Error("repoRoot must be an absolute path other than /");
  }
  const permission = reviewerPermission();
  const isAllowed = (tool: string): boolean => allows(permission[tool] ?? permission["*"]);
  return Object.freeze({
    repoRoot,
    permission,
    allowedTools: READ_TOOLS,
    isAllowed,
  });
}

const allows = (rule: PermissionRule | undefined): boolean =>
  rule === "allow" || (typeof rule === "object" && rule["*"] === "allow");
