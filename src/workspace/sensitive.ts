// Which paths never enter the reviewer workspace, whatever their content. Name-based and deterministic.

/** Directories that are skipped with everything below them. */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([".git", ".hg", ".svn", "node_modules", ".ssh", ".gnupg", ".aws"]);

const EXCLUDED_FILE_NAMES: ReadonlySet<string> = new Set([
  ".npmrc", ".netrc", ".pgpass", ".git-credentials", ".htpasswd", ".dockercfg", "credentials", "credentials.json",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "secrets.json", "secrets.yml", "secrets.yaml", "service-account.json",
  "terraform.tfstate", "terraform.tfstate.backup",
]);

const EXCLUDED_EXTENSIONS = /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|tfvars)$/i;
const ENV_FILE = /^\.env(\..+)?$/i;
const ENV_TEMPLATE = /\.(example|sample|template|dist)$/i;

export const isExcludedDir = (name: string): boolean => EXCLUDED_DIRS.has(name);

export function isSensitiveFileName(name: string): boolean {
  if (EXCLUDED_FILE_NAMES.has(name.toLowerCase())) return true;
  if (EXCLUDED_EXTENSIONS.test(name)) return true;
  return ENV_FILE.test(name) && !ENV_TEMPLATE.test(name);
}

/** True when any component of a repository-relative path is an excluded directory or a sensitive file name. */
export function isSensitivePath(path: string): boolean {
  const parts = path.split("/");
  const last = parts[parts.length - 1] ?? "";
  return parts.slice(0, -1).some(isExcludedDir) || isSensitiveFileName(last) || isExcludedDir(last);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A single path component that is safe to create on disk and to print: no separators, traversal or control characters. */
export function isSafeName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name !== "." && name !== ".." && !name.includes("/") && !CONTROL_CHARS.test(name);
}
