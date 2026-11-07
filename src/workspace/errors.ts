export type WorkspaceErrorCode =
  | "source_missing"
  | "source_not_directory"
  | "out_not_empty"
  | "out_overlaps_source"
  | "limit_exceeded"
  | "diff_unreadable"
  | "diff_parse_failed"
  | "sanitize_failed"
  | "write_failed"
  | "internal_error";

/**
 * A failure while preparing the reviewer workspace. The message is a fixed string chosen from the code:
 * it never includes a path, file content or the text of an underlying error, because those can hold secrets.
 */
export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode) {
    super(`workspace preparation failed: ${code}`);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

export const toWorkspaceError = (error: unknown): WorkspaceError =>
  error instanceof WorkspaceError ? error : new WorkspaceError("internal_error");
