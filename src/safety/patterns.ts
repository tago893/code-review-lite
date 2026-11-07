// Secret-detection patterns. Deterministic regular expressions only; no model calls.
// Every pattern is linear-time (no nested quantifiers) so hostile input cannot cause catastrophic backtracking.

export type RedactionKind =
  | "provider_key"
  | "private_key"
  | "secret_assignment"
  | "auth_header"
  | "bearer_token"
  | "connection_string";

export const REDACTED = "[REDACTED]";

/** Credentials with a distinctive prefix. The whole token is replaced. */
export const PROVIDER_KEY_PATTERNS: readonly RegExp[] = [
  /\bgsk_[A-Za-z0-9]{8,}/g, // Groq
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI, Anthropic (sk-ant-...)
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g, // GitHub fine-grained
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAIza[A-Za-z0-9_-]{35}/g, // Google API key
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

export const PEM_HEADER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
export const PEM_FOOTER = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

const CREDENTIAL = "[A-Za-z0-9._~+/=-]{8,}";

/** Authorization / Proxy-Authorization header with a literal credential. Groups: 1 = everything up to the credential. */
export const AUTH_HEADER = new RegExp(
  `((?:proxy-)?authorization["']?\\s*[:=]\\s*["']?(?:Bearer|Basic|Token|Digest|Negotiate)\\s+)${CREDENTIAL}`,
  "gi",
);

/** A bare "Bearer <token>" outside a header. Groups: 1 = "Bearer ", 2 = token. */
export const BARE_BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{3,})/g;

/** Words that follow "Bearer" in prose, not credentials. */
export const PROSE_AFTER_BEARER: ReadonlySet<string> = new Set([
  "token", "tokens", "auth", "authentication", "authorization", "scheme", "header", "headers", "type", "and", "the",
  "is", "are", "or", "for", "to", "in", "of", "with", "credentials", "credential", "access", "value", "format",
]);

/** scheme://user:password@host. Groups: 1 = "scheme://user:", 2 = password, 3 = "@". */
export const CONNECTION_STRING = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@"'<>]+:)([^\s@/"'<>]+)(@)/gi;

/**
 * name = value, where the name ends in a secret word. Groups: 1 = name and separator,
 * 2 = double-quoted value, 3 = single-quoted value, 4 = unquoted value.
 * The unquoted form must not be followed by "(" "." or "[" so calls and property reads are not redacted.
 */
export const SECRET_ASSIGNMENT = new RegExp(
  "([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|(?:api|access|secret|private|signing|encryption|auth)[_-]?key)" +
    "[\"']?\\s*[:=]\\s*)" +
    "(?:\"([^\"\\n]*)\"|'([^'\\n]*)'|([A-Za-z0-9_+/=!@#%^*~-]{8,})(?![A-Za-z0-9_+/=!@#%^*~.(\\[-]))",
  "gi",
);

const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set([
  "password", "passwd", "pass", "pwd", "secret", "changeme", "change-me", "changeit", "example", "test", "dummy",
  "placeholder", "redacted", "none", "null", "undefined", "token", "apikey", "api-key", "api_key", "xxx", "todo",
  "foo", "bar", "admin", "root", "string", "true", "false",
]);

/** True for values that are clearly not a real credential: empty, templates, env lookups, "changeme", "your-key". */
export function isPlaceholder(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v.length === 0 || v.includes(REDACTED.toLowerCase())) return true;
  if (PLACEHOLDER_WORDS.has(v)) return true;
  if (/^(your|my|the|some|example|sample|dummy|fake|test)[-_ ]/.test(v)) return true;
  if (/^[$<{%]/.test(v) || /^\*+$|^x+$|^\.+$|^-+$|^_+$/.test(v)) return true;
  if (/(process\.env|os\.environ|getenv|env\[)/.test(v)) return true;
  return false;
}

/** A quoted or bare value that looks like a real secret literal, as opposed to prose or an identifier. */
export function looksLikeSecretLiteral(value: string, quoted: boolean): boolean {
  if (isPlaceholder(value)) return false;
  if (quoted) return value.length >= 4 && !/\s/.test(value);
  // Unquoted: require a digit or symbol so plain identifiers (getToken, token_value) are not redacted.
  return /[0-9+/=!@#%^*~-]/.test(value);
}

/** True when a bare token after "Bearer" is a credential rather than the next word of a sentence. */
export function isBearerCredential(token: string): boolean {
  if (isPlaceholder(token) || PROSE_AFTER_BEARER.has(token.toLowerCase())) return false;
  if (/^[a-z]+$/.test(token) && token.length >= 7) return false; // a plain lowercase word, e.g. "authentication"
  return true;
}
