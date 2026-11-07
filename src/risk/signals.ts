import type { RemovedEntry } from "../diff/filter.js";
import type { DiffEntry } from "../types.js";
import {
  baseName, isApiSchema, isCiOrSecurityConfig, isDependencyManifest, isDocFile, isMigration,
  isPackageJson, trustBoundaryTerm,
} from "./paths.js";
import { CONTENT_RULES, PACKAGE_JSON_RULE, toContext, type RuleHit } from "./rules.js";
import type { RiskSignal, SignalFamily } from "./types.js";

export type { RiskSignal, SignalFamily } from "./types.js";

interface PathRule {
  readonly signal: string;
  readonly family: SignalFamily;
  /** Returns the reason when the path matches. */
  readonly check: (path: string) => string | undefined;
}

const PATH_RULES: readonly PathRule[] = [
  {
    signal: "trust_boundary_path",
    family: "trust_boundary",
    check: (path) => {
      const term = trustBoundaryTerm(path);
      return term === undefined ? undefined : `path is in a trust-boundary area ("${term}")`;
    },
  },
  {
    signal: "ci_security_config_changed",
    family: "weakened_safeguard",
    check: (path) => (isCiOrSecurityConfig(path) ? "CI, lint or security configuration changed" : undefined),
  },
  {
    signal: "db_migration",
    family: "contract_change",
    check: (path) => (isMigration(path) ? "database migration or schema file changed" : undefined),
  },
  {
    signal: "api_schema_file",
    family: "contract_change",
    check: (path) => (isApiSchema(path) ? "API schema definition changed" : undefined),
  },
  {
    signal: "dependency_manifest",
    family: "contract_change",
    check: (path) => (isDependencyManifest(path) ? `dependency manifest changed (${baseName(path)})` : undefined),
  },
];

/**
 * Deterministic behavior signals from paths and changed lines. `excluded` is the metadata for files the
 * noise filter removed: their content is not read, but their paths still count, so excluding a file can
 * never hide a sensitive path or a changed lockfile.
 */
export function detectSignals(
  entries: readonly DiffEntry[],
  excluded: readonly RemovedEntry[] = [],
): readonly RiskSignal[] {
  const signals: RiskSignal[] = [];
  for (const entry of entries) {
    if (isDocFile(entry.newPath) && isDocFile(entry.oldPath)) continue;
    signals.push(...pathSignals(entry.newPath, [entry.newPath, entry.oldPath]));
    signals.push(...contentSignals(entry));
  }
  for (const item of excluded) {
    signals.push(...pathSignals(item.path, [item.path, item.oldPath]));
    if (item.kind === "lockfile") {
      signals.push(
        build("dependency_manifest", "contract_change", item.path, { reason: `lockfile changed (${baseName(item.path)})` }),
      );
    }
  }
  return Object.freeze(signals);
}

function pathSignals(file: string, paths: readonly string[]): RiskSignal[] {
  const distinct = [...new Set(paths)];
  const out: RiskSignal[] = [];
  for (const rule of PATH_RULES) {
    for (const path of distinct) {
      const reason = rule.check(path);
      if (reason === undefined) continue;
      out.push(build(rule.signal, rule.family, file, { reason: path === file ? reason : `${reason} (old path ${path})` }));
      break;
    }
  }
  return out;
}

function contentSignals(entry: DiffEntry): RiskSignal[] {
  const context = toContext(entry);
  const out: RiskSignal[] = [];
  for (const rule of CONTENT_RULES) {
    const hit = rule.detect(context);
    if (hit !== undefined) out.push(build(rule.signal, rule.family, entry.newPath, hit));
  }
  if (isPackageJson(entry.newPath)) {
    const hit = PACKAGE_JSON_RULE.detect(context);
    if (hit !== undefined) out.push(build(PACKAGE_JSON_RULE.signal, PACKAGE_JSON_RULE.family, entry.newPath, hit));
  }
  return out;
}

function build(
  signal: string,
  family: SignalFamily,
  file: string,
  hit: RuleHit,
): RiskSignal {
  return Object.freeze({
    signal,
    family,
    file,
    reason: hit.reason,
    ...(hit.line !== undefined ? { line: hit.line } : {}),
    ...(hit.evidence !== undefined ? { evidence: hit.evidence } : {}),
  });
}
