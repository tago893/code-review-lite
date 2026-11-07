/** The six signal families from the approved design spec. */
export type SignalFamily =
  | "trust_boundary"
  | "dangerous_sink"
  | "weakened_safeguard"
  | "concurrency_state"
  | "contract_change"
  | "performance";

export interface RiskSignal {
  /** The specific rule that fired, for example "sql_string_building". */
  readonly signal: string;
  readonly family: SignalFamily;
  readonly file: string;
  /** Why this is a risk signal, in words a reviewer can read. */
  readonly reason: string;
  /** Line in the new file (added lines) or old file (removed lines) when the signal comes from a line. */
  readonly line?: number;
  /** The matched line, trimmed and truncated. */
  readonly evidence?: string;
}
