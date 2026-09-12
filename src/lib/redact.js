import path from 'node:path';

const REDACTED = '[REDACTED]';
const REDACTED_PATH = '[REDACTED_PATH]';

const SENSITIVE_KEY_RE = /(?:^|[_-])(?:api[_-]?key|authorization|bearer|browser[_-]?(?:id|oauth)|client[_-]?secret|company|container[_-]?id|cookie|credential|dashboard[_-]?password|id[_-]?token|openid|otp|pass(?:word|wd)?|profile[_-]?id|refresh[_-]?token|secret|session[_-]?secret|shop[_-]?id|signature|site[_-]?id|sso|store[_-]?id|token|user(?:name)?|verification[_-]?code|webhook)(?:$|[_-])/i;
const WINDOWS_ABSOLUTE_RE = /^(?:[a-z]:[\\/]|\\\\)/i;
const EMBEDDED_ABSOLUTE_RE = /(^|[\s,"'=:(])((?:\/[A-Za-z0-9._@+~-]+){2,}(?:\/[A-Za-z0-9._@+~\-/]*)?|(?:[A-Za-z]:[\\/](?:[^\s"'<>|]+[\\/])*[^\s"'<>|]*))/g;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const RELATIVE_URL_WITH_AUTH_RE = /(^|[\s,"'=:(])((?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)[?#][^\s"'<>]+)/g;

function isSensitiveKey(key) {
  const normalized = String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
  return SENSITIVE_KEY_RE.test(normalized);
}

function isAbsolutePath(value) {
  return path.isAbsolute(value) || WINDOWS_ABSOLUTE_RE.test(value);
}

function artifactPath(value, rootDir) {
  if (!rootDir || !path.isAbsolute(value)) return null;
  const root = path.resolve(rootDir);
  const candidate = path.resolve(value);
  const relative = path.relative(root, candidate);
  if (relative === '') return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

/**
 * Return a storage-safe URL. Authentication data is never retained: userinfo,
 * query parameters and fragments are removed. Non-URL strings are returned
 * unchanged so callers can safely apply this to optional URL fields.
 */
export function sanitizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return value;
  const input = value.trim();
  if (/^(?:data|file|javascript):/i.test(input)) return REDACTED;
  if (!/^(?:https?:)?\/\//i.test(input) && !input.startsWith('/')) return value;
  const protocolRelative = input.startsWith('//');
  const rootRelative = input.startsWith('/') && !protocolRelative;
  let parsed;
  try {
    parsed = rootRelative
      ? new URL(input, 'https://redaction.invalid')
      : new URL(protocolRelative ? `https:${input}` : input);
  } catch {
    // A malformed URL is precisely where query-token redaction must not fail
    // open. A valid-looking root-relative path may retain only its path; an
    // invalid absolute/protocol-relative URL is suppressed in full.
    const pathOnly = input.split(/[?#]/, 1)[0];
    if (rootRelative && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(pathOnly)) return pathOnly || '/';
    return REDACTED;
  }

  // Only retain navigational schemes. A data/javascript/file URL can itself
  // contain secrets or a local filesystem path and has no place in a report.
  if (!['http:', 'https:'].includes(parsed.protocol)) return REDACTED;
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  if (rootRelative) return parsed.pathname || '/';
  if (protocolRelative) return `//${parsed.host}${parsed.pathname || '/'}`;
  return parsed.toString();
}

function redactEmbeddedUrl(raw) {
  let candidate = raw;
  let suffix = '';
  // Punctuation adjacent to a URL belongs to the sentence, not the URL.
  while (/[),.;\]}，。；、）】]$/.test(candidate)) {
    suffix = candidate.slice(-1) + suffix;
    candidate = candidate.slice(0, -1);
  }
  return `${sanitizeUrl(candidate)}${suffix}`;
}

/**
 * Remove credentials, authentication URLs and local absolute paths from text
 * before the text reaches logs, alerts or reports.
 */
export function redactText(value) {
  if (value === null || value === undefined) return value;
  let text = String(value);
  text = text.replace(URL_RE, redactEmbeddedUrl);
  text = text.replace(RELATIVE_URL_WITH_AUTH_RE, (_all, prefix, candidate) => `${prefix}${sanitizeUrl(candidate)}`);
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]');
  text = text.replace(/\bamzn1\.(?:account|auth|login|session)\.[A-Za-z0-9._~+/=-]+\b/gi, '[REDACTED_AMAZON_ID]');
  text = text.replace(
    /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
    '$1 [REDACTED]',
  );
  text = text.replace(
    /(["']?(?:[a-z0-9_-]*(?:browser[_-]?(?:id|oauth)|container[_-]?id|profile[_-]?id|shop[_-]?id|site[_-]?id|store[_-]?id)|api[_-]?key|auth|authorization|client[_-]?secret|cookie|id[_-]?token|otp|pass(?:word|wd)?|refresh[_-]?token|secret|session[_-]?secret|signature|sso|token|verification[_-]?code|webhook)["']?\s*[:=]\s*)(["']?)([^\s,;}&"']+|[^"']*)(\2)/gi,
    (_all, prefix, quote) => `${prefix}${quote}${REDACTED}${quote}`,
  );
  text = text.replace(
    /((?:--)?(?:browser[-_]?oauth|browser[-_]?id|container[-_]?id|profile[-_]?id|shop[-_]?id|site[-_]?id|store[-_]?id)(?:=|\s+))([^\s"']+)/gi,
    `$1${REDACTED}`,
  );
  text = text.replace(
    /((?:验证码|一次性密码|verification\s*code|one[- ]time\s*(?:password|code)|otp)\s*[:：=]?\s*)\d{4,8}/gi,
    `$1${REDACTED}`,
  );
  text = text.replace(EMBEDDED_ABSOLUTE_RE, (_all, prefix) => `${prefix}${REDACTED_PATH}`);
  return text;
}

/**
 * Deep-clone a value into a form safe for persistent reports and APIs.
 *
 * options.rootDir converts absolute paths inside that artifact root to stable
 * POSIX-relative paths. Every other absolute path is replaced. Sensitive keys
 * are redacted regardless of their value, and strings receive URL/text cleanup.
 */
export function sanitizeForStorage(value, options = {}) {
  const rootDir = options.rootDir ? path.resolve(options.rootDir) : null;
  const seen = new WeakSet();

  const walk = (input, key = '') => {
    if (isSensitiveKey(key)) return REDACTED;
    if (input === null || input === undefined || typeof input === 'boolean' || typeof input === 'number') return input;
    if (typeof input === 'bigint') return input.toString();
    if (typeof input === 'string') {
      if (isAbsolutePath(input)) return artifactPath(input, rootDir) || REDACTED_PATH;
      const safeUrl = sanitizeUrl(input);
      if (safeUrl !== input) return safeUrl;
      return redactText(input);
    }
    if (input instanceof Date) return input.toISOString();
    if (Buffer.isBuffer(input)) return '[REDACTED_BINARY]';
    if (typeof input !== 'object') return redactText(String(input));
    if (seen.has(input)) return '[REDACTED_CIRCULAR]';
    seen.add(input);
    if (Array.isArray(input)) return input.map((item) => walk(item));
    const out = {};
    for (const [childKey, childValue] of Object.entries(input)) {
      out[childKey] = walk(childValue, childKey);
    }
    return out;
  };

  return walk(value);
}

export const REDACTION_MARKERS = Object.freeze({ REDACTED, REDACTED_PATH });
