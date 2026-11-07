// Shared types. Pure declarations: no runtime code, so nothing here can leak a secret or mutate state.

export type Severity = "critical" | "warning" | "suggestion";

export type FindingLevel =
  | "citation_valid"
  | "semantically_supported"
  | "independently_confirmed"
  | "refuted";

export type Completion = "complete" | "incomplete";

export type Tier = "trivial" | "lite" | "full";

export type Verdict =
  | "approved"
  | "approved_with_comments"
  | "minor_issues"
  | "significant_concerns"
  | "not_determined";

export type Category = "code_quality" | "security" | "performance";

export interface Finding {
  readonly id: string;
  readonly category: Category;
  readonly severity: Severity;
  readonly file: string;
  readonly line: number;
  readonly evidence: string;
  readonly claim: string;
  readonly path: string;
  readonly level?: FindingLevel;
  readonly reviewer: string;
}

export interface DiffEntry {
  readonly oldPath: string;
  readonly newPath: string;
  readonly addedLines: readonly string[];
  readonly removedLines: readonly string[];
  /** New-file line numbers of the added lines. */
  readonly addedLineNumbers: readonly number[];
  /** Old-file line numbers of the removed lines. */
  readonly removedLineNumbers: readonly number[];
  readonly isBinary: boolean;
  readonly isRename: boolean;
  readonly patch: string;
}
