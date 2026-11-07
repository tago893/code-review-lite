// Path-based classification. Pure functions over repository-relative paths; no file access.

// .txt is deliberately not a documentation extension: requirements.txt and CMakeLists.txt are code.
const DOC_FILE = /\.(md|mdx|rst|adoc)$/i;

const TEST_PATHS: readonly RegExp[] = [
  /(^|\/)(tests?|__tests__|specs?)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /_test\.(go|py|rs)$/i,
  /(^|\/)test_[^/]*\.py$/i,
  /(Test|Tests|IT)\.(java|kt|cs)$/,
];

/** Words that, as a whole token of a path, mark a trust boundary (auth, crypto, sessions, secrets...). */
const TRUST_TERMS: ReadonlySet<string> = new Set([
  "auth", "authn", "authz", "authentication", "authorization", "oauth", "sso", "jwt",
  "crypto", "cryptography", "security", "session", "sessions", "token", "tokens",
  "permission", "permissions", "secret", "secrets", "credential", "credentials",
  "password", "passwords", "cors", "csrf", "middleware", "acl", "rbac",
]);

const CI_SECURITY_CONFIG: readonly RegExp[] = [
  /(^|\/)\.github\/(workflows|actions)\//,
  /(^|\/)\.gitlab-ci\.ya?ml$/,
  /(^|\/)Jenkinsfile/,
  /(^|\/)\.circleci\//,
  /(^|\/)azure-pipelines\.ya?ml$/,
  /(^|\/)\.eslintrc(\.|$)/,
  /(^|\/)eslint\.config\./,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)\.snyk$/,
  /(^|\/)\.pre-commit-config\.ya?ml$/,
  /(^|\/)dependabot\.ya?ml$/,
  /(^|\/)sonar-project\.properties$/,
  /(^|\/)\.semgrep/,
  /(^|\/)\.bandit/,
  /codeql/i,
];

const MIGRATION: readonly RegExp[] = [
  /(^|\/)migrations?\//i,
  /(^|\/)alembic\/versions\//,
  /(^|\/)db\/migrate\//,
  /\.prisma$/,
  /\.sql$/i,
];

const API_SCHEMA: readonly RegExp[] = [/(openapi|swagger)[^/]*\.(ya?ml|json)$/i, /\.proto$/, /\.(graphql|gql)$/];

const MANIFEST_NAMES: ReadonlySet<string> = new Set([
  "pyproject.toml", "Pipfile", "Cargo.toml", "go.mod", "pom.xml", "build.gradle",
  "build.gradle.kts", "Gemfile", "composer.json",
]);

export const isDocFile = (path: string): boolean => DOC_FILE.test(path);

export const isTestPath = (path: string): boolean => TEST_PATHS.some((pattern) => pattern.test(path));

/** The first trust-boundary word found in the path (camelCase and separators are split), if any. */
export function trustBoundaryTerm(path: string): string | undefined {
  const tokens = path.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  return tokens.find((token) => TRUST_TERMS.has(token));
}

export const isCiOrSecurityConfig = (path: string): boolean => CI_SECURITY_CONFIG.some((p) => p.test(path));

export const isMigration = (path: string): boolean => MIGRATION.some((p) => p.test(path));

export const isApiSchema = (path: string): boolean => API_SCHEMA.some((p) => p.test(path));

export const baseName = (path: string): string => path.split("/").pop() ?? path;

/** Manifests where any change is a dependency change. package.json is handled by content, not here. */
export function isDependencyManifest(path: string): boolean {
  const name = baseName(path);
  return MANIFEST_NAMES.has(name) || /^requirements[^/]*\.txt$/.test(name);
}

export const isPackageJson = (path: string): boolean => baseName(path) === "package.json";
