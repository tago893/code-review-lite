import { APPROVED_TOOL_IDS } from "../mcp/ids.js";

export const REPO_ROOT = "/repo";
export const CONTEXT_ROOT = "/review/context";

export type PermissionValue = "allow" | "deny";
export type PermissionRule = PermissionValue | Readonly<Record<string, PermissionValue>>;

/**
 * OpenCode permissions for reviewers: deny by default. OpenCode's own file tools (read, grep, glob, list) are denied
 * because their output cannot be bounded and they follow symlinks; the bounded tools of CRA's own MCP server
 * (cra_read, cra_grep, cra_glob, cra_list) are the only tools allowed. This is a second layer. The boundary that
 * actually keeps raw data away from the agent is the mounts: only the sanitised, read-only snapshot exists inside
 * the agent container.
 */
export function reviewerPermission(): Readonly<Record<string, PermissionRule>> {
  return Object.freeze({
    "*": "deny",
    read: "deny",
    grep: "deny",
    glob: "deny",
    list: "deny",
    [APPROVED_TOOL_IDS[0] as string]: "allow",
    [APPROVED_TOOL_IDS[1] as string]: "allow",
    [APPROVED_TOOL_IDS[2] as string]: "allow",
    [APPROVED_TOOL_IDS[3] as string]: "allow",
    edit: "deny",
    bash: "deny",
    webfetch: "deny",
    websearch: "deny",
    task: "deny",
    todowrite: "deny",
    skill: "deny",
    question: "deny",
    lsp: "deny",
    doom_loop: "deny",
    // OpenCode's working directory is a trusted empty directory and its own file tools are off, so nothing outside it is allowed.
    external_directory: Object.freeze({ "*": "deny" } as const),
  });
}
