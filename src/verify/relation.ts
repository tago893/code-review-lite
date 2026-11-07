import type { DiffEntry } from "../types.js";
import { readSnapshotLines } from "./citation.js";

// Location is not causality: a changed function can break a caller on a line the diff never touched. This module
// links an unchanged cited line to the change deterministically: the line must mention a symbol whose declaration
// was added, removed or enclosed by a changed hunk. It is a heuristic over identifiers, not a call graph, and it
// errs toward keeping a finding (an over-linked finding is shown as a PR finding; an under-linked one is shown as
// possibly pre-existing, never hidden).

const DECLARATION = /\b(?:function\*?|class|interface|type|enum|const|let|var|def|fn|func|struct|trait)\s+([A-Za-z_$][\w$]*)/g;
const METHOD = /^\s*(?:(?:export|public|private|protected|static|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{?\s*$/;
const NOT_A_SYMBOL = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try", "with", "new", "typeof", "await", "super"]);
const HUNK_CONTEXT = /^@@[^@]*@@ ?(.*)$/;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

function symbolsIn(line: string): string[] {
  const found = [...line.matchAll(DECLARATION)].map((m) => m[1] ?? "");
  const method = METHOD.exec(line)?.[1];
  if (method !== undefined) found.push(method);
  return found.filter((s) => s !== "" && !NOT_A_SYMBOL.has(s));
}

/** Names declared on added or removed lines, or by the function/class a changed hunk sits in (the @@ context). */
export function changedSymbols(entries: readonly DiffEntry[]): ReadonlySet<string> {
  const symbols = new Set<string>();
  for (const entry of entries) {
    for (const line of [...entry.addedLines, ...entry.removedLines]) for (const s of symbolsIn(line)) symbols.add(s);
    for (const line of entry.patch.split("\n")) {
      const context = HUNK_CONTEXT.exec(line)?.[1];
      if (context) for (const s of symbolsIn(context)) symbols.add(s);
    }
  }
  return symbols;
}

/** The changed symbols that the cited source line mentions. Empty means the line is not linked to the change. */
export async function linkedSymbols(repoRoot: string, file: string, line: number, symbols: ReadonlySet<string>): Promise<readonly string[]> {
  try {
    const text = (await readSnapshotLines(repoRoot, file))[line - 1] ?? "";
    const mentioned = new Set((text.match(IDENTIFIER) ?? []).filter((id) => symbols.has(id)));
    return [...mentioned].sort();
  } catch {
    return [];
  }
}
