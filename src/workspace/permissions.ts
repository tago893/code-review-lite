export const REPO_ROOT = "/repo";
export const CONTEXT_ROOT = "/review/context";

export type PermissionValue = "allow" | "deny";
export type PermissionRule = PermissionValue | Readonly<Record<string, PermissionValue>>;

/**
 * OpenCode permissions for reviewers: deny by default, read-only exploration only. This is a second layer.
 * The boundary that actually keeps raw data away from the agent is the mounts: only the sanitised, read-only
 * snapshot exists inside the agent container.
 * Paths inside the working directory match relative to it, and anything outside is gated by external_directory.
 */
export function reviewerPermission(): Readonly<Record<string, PermissionRule>> {
  return Object.freeze({
    "*": "deny",
    read: Object.freeze({ "*": "allow", "*.env": "deny", "*.env.*": "deny" } as const),
    grep: "allow",
    glob: "allow",
    list: "allow",
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
    external_directory: Object.freeze({ "*": "deny", [`${CONTEXT_ROOT}/**`]: "allow" } as const),
  });
}
