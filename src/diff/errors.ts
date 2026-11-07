/** Raised for diff text that is malformed or uses a feature this parser deliberately does not support. */
export class DiffParseError extends Error {
  /** 1-based line of the diff text where the problem was found. */
  readonly line: number;

  constructor(message: string, line: number) {
    super(`${message} (diff line ${line})`);
    this.name = "DiffParseError";
    this.line = line;
  }
}
