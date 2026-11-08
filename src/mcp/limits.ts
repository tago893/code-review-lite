/** Hard limits of the bounded exploration tools. Every result is cut at these, with an explicit marker. */
export const LIMITS = Object.freeze({
  /** Lines returned by one read when the model does not say. */
  defaultReadLines: 100,
  /** Most lines one read may return, however many are asked for. */
  maxReadLines: 200,
  /** Most bytes of file text one read may return. */
  maxReadBytes: 6_000,
  /** A longer line is cut and marked (minified files, generated blobs). */
  maxLineChars: 300,
  /** Files larger than this are not read; the model is told to grep. */
  maxFileBytes: 2_000_000,
  maxGrepMatches: 40,
  maxGrepBytes: 6_000,
  /** Files larger than this are skipped by grep. */
  maxGrepFileBytes: 512 * 1024,
  maxGrepMatchesPerFile: 10,
  grepTimeoutMs: 5_000,
  maxGlobResults: 100,
  maxListEntries: 100,
  maxListBytes: 4_000,
  maxPatternChars: 200,
  maxPathChars: 500,
});

export type Limits = typeof LIMITS;
