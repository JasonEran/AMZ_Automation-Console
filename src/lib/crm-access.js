import crypto from 'node:crypto';
import { CHECK_IDS } from '../checks/registry.js';

const CHALLENGE_TTL_MS = 120_000;
const TICKET_TTL_MS = 60_000;
const SESSION_TTL_MS = 30 * 60_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const BEARER_RE = /^[A-Za-z0-9._~+/-]+=*$/;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CHECKS = new Set(CHECK_IDS);
const CORE_KEYS = ['CLIENT_ID', 'API_TOKEN', 'STORE_KEYS', 'PUBLIC_ORIGIN'];
const PREFIX = 'AMZGUARD_CRM_';

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function equalSecret(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function strictObject(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw failure(400, 'CRM_INVALID_INPUT', 'Invalid CRM request fields');
  }
}

function destination(input) {
  if (typeof input.storeKey !== 'string' || !IDENTIFIER_RE.test(input.storeKey)) {
    throw failure(400, 'CRM_INVALID_STORE', 'A valid storeKey is required');
  }
  if (!['results', 'data'].includes(input.view)) {
    throw failure(400, 'CRM_INVALID_VIEW', 'view must be results or data');
  }
  const checkId = input.checkId ?? null;
  if (checkId !== null && (typeof checkId !== 'string' || !CHECKS.has(checkId))) {
    throw failure(400, 'CRM_INVALID_CHECK', 'Unknown checkId');
  }
  return { storeKey: input.storeKey, checkId, view: input.view };
}

function httpsUrl(value, originOnly = false) {
  let url;
  try { url = new URL(value); } catch { /* reject below */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash
    || url.search || (originOnly && url.pathname !== '/')) {
    throw failure(503, 'CRM_CONFIG_INVALID', 'CRM URLs must be fixed HTTPS URLs without credentials, query or fragment');
  }
  return originOnly ? url.origin : url.href;
}

/**
 * Independent, read-only CRM authentication. No filesystem, network, local user
 * store, Dashboard role, or Amazon operation is used by this module.
 *
 * Configuration is read again on every call. `stores` may be an array or a
 * function returning the current array, so a disabled/removed store immediately
 * loses access. Changing any CRM credential/configuration invalidates existing
 * handshakes, tickets, and sessions. Unknown allow-list entries never authorize.
 *
 * All expiresAt/issuedAt values are epoch milliseconds. Tokens are opaque random
 * values; only their SHA-256 digests are held in memory. Restarting the process
 * invalidates all browser authentication. Limits reject new entries rather than
 * evicting active entries. `limits` and `now` support deterministic offline tests.
 *
 * The HTTP caller owns TLS, canonical Host checks, request limits, same-origin
 * JSON-only exchange, cookie attributes, and denial of non-CRM routes. Keep the
 * browserToken in a Secure/HttpOnly binding cookie, never a response body or URL.
 * A checkId/view selects the initial page; storeKey is the authorization scope.
 * Errors expose status/statusCode and code without including credential values.
 */
export function createCrmAccess({ env = process.env, stores = [], now = Date.now, limits = {} } = {}) {
  const capacities = { challenges: 1000, tickets: 1000, sessions: 5000, ...limits };
  if (Object.keys(capacities).some((key) => !['challenges', 'tickets', 'sessions'].includes(key)
    || !Number.isSafeInteger(capacities[key]) || capacities[key] < 1)) {
    throw failure(503, 'CRM_CONFIG_INVALID', 'Invalid CRM memory capacity');
  }
  const challenges = new Map();
  const tickets = new Map();
  const sessions = new Map();
  const principals = new WeakMap();
  let priorVersion = null;

  function clock() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw failure(503, 'CRM_CLOCK_INVALID', 'CRM clock unavailable');
    return value;
  }

  function readSettings() {
    const values = CORE_KEYS.map((key) => env[`${PREFIX}${key}`] || '');
    const callback = env[`${PREFIX}CALLBACK_URL`] || '';
    if ([...values, callback].some((value) => typeof value !== 'string')) {
      throw failure(503, 'CRM_CONFIG_INVALID', 'Invalid CRM configuration');
    }
    if (!values.some(Boolean) && !callback) {
      challenges.clear(); tickets.clear(); sessions.clear(); priorVersion = null;
      return { enabled: false, storeKeys: [], ssoAvailable: false };
    }
    const [clientId, apiToken, storeList, origin] = values;
    if (!IDENTIFIER_RE.test(clientId) || apiToken.length < 32 || apiToken.length > 512
      || !BEARER_RE.test(apiToken) || !storeList || !origin) {
      throw failure(503, 'CRM_CONFIG_INVALID', 'CRM configuration is incomplete or invalid');
    }
    const storeKeys = storeList.split(',').map((key) => key.trim());
    if (!storeKeys.length || storeKeys.length > 1000 || new Set(storeKeys).size !== storeKeys.length
      || storeKeys.some((key) => !IDENTIFIER_RE.test(key))) {
      throw failure(503, 'CRM_CONFIG_INVALID', 'CRM store allow-list must contain exact, unique store keys');
    }
    const publicOrigin = httpsUrl(origin, true);
    const callbackUrl = callback ? httpsUrl(callback) : null;
    const version = digest(JSON.stringify([clientId, apiToken, storeKeys, publicOrigin, callbackUrl]));
    if (priorVersion !== version) {
      challenges.clear(); tickets.clear(); sessions.clear(); priorVersion = version;
    }
    return { enabled: true, clientId, apiToken, storeKeys, publicOrigin, callbackUrl, ssoAvailable: Boolean(callbackUrl), version };
  }

  function settings() {
    try { return readSettings(); }
    catch (error) {
      challenges.clear(); tickets.clear(); sessions.clear(); priorVersion = null;
      throw error;
    }
  }

  function currentStores() {
    const value = typeof stores === 'function' ? stores() : stores;
    if (!Array.isArray(value)) throw failure(503, 'CRM_CONFIG_INVALID', 'CRM store configuration unavailable');
    return value;
  }

  function requireEnabled() {
    const config = settings();
    if (!config.enabled) throw failure(503, 'CRM_DISABLED', 'CRM access is disabled');
    return config;
  }

  function checkStore(config, storeKey) {
    const matching = currentStores().filter((store) => store?.key === storeKey);
    if (!config.storeKeys.includes(storeKey) || matching.length !== 1 || matching[0].enabled === false) {
      throw failure(403, 'CRM_STORE_FORBIDDEN', 'Store is not available to this CRM client');
    }
  }

  function prune(time = clock()) {
    for (const table of [challenges, tickets, sessions]) {
      for (const [key, record] of table) if (record.expiresAt <= time) table.delete(key);
    }
  }

  function available(table, name) {
    if (table.size >= capacities[name]) throw failure(503, 'CRM_CAPACITY', 'CRM authentication capacity reached');
  }

  function principal(value, metadata) {
    const result = Object.freeze(value);
    principals.set(result, metadata);
    return result;
  }

  function verifyPrincipal(value, config) {
    const meta = value && typeof value === 'object' ? principals.get(value) : null;
    if (!meta || meta.version !== config.version || value.clientId !== config.clientId) {
      throw failure(401, 'CRM_AUTH_REQUIRED', 'CRM authentication required');
    }
    if (meta.kind === 'session') {
      const record = sessions.get(meta.key);
      if (!record || record.expiresAt <= clock()) throw failure(401, 'CRM_SESSION_INVALID', 'CRM session expired or invalid');
      checkStore(config, record.scope.storeKey);
    }
    return meta;
  }

  // Validate partial configuration immediately, while preserving disabled mode.
  settings();

  return {
    get enabled() { return settings().enabled; },

    /** Safe configuration for capability responses; never includes a secret. */
    publicConfig() {
      const config = settings();
      const active = config.enabled ? config.storeKeys.filter((key) => {
        try { checkStore(config, key); return true; } catch { return false; }
      }) : [];
      return {
        enabled: config.enabled, ssoAvailable: config.ssoAvailable,
        clientId: config.clientId || null, publicOrigin: config.publicOrigin || null,
        storeKeys: active, challengeTtlSeconds: 120, ticketTtlSeconds: 60, sessionTtlSeconds: 1800,
      };
    },

    /** req must expose headers.authorization; cookies/query credentials are ignored. */
    authenticateBearer(req) {
      const config = requireEnabled();
      const header = req?.headers?.authorization;
      const match = typeof header === 'string' ? /^Bearer ([^\s,]+)$/i.exec(header) : null;
      if (!match || !equalSecret(match[1], config.apiToken)) {
        throw failure(401, 'CRM_AUTH_REQUIRED', 'CRM authentication required');
      }
      return principal({ kind: 'crm-client', clientId: config.clientId, storeKeys: Object.freeze([...config.storeKeys]) },
        { kind: 'client', version: config.version });
    },

    /** Revalidate current client/store scope; a browser session always has one store. */
    authorizeStore(identity, storeKey) {
      const config = requireEnabled();
      const meta = verifyPrincipal(identity, config);
      checkStore(config, storeKey);
      if (meta.kind === 'session' && identity.storeKey !== storeKey) {
        throw failure(403, 'CRM_STORE_FORBIDDEN', 'Store is outside this CRM session');
      }
      return { clientId: config.clientId, storeKey };
    },

    /** Begin a browser-bound handshake. callbackUrl is built only from trusted config. */
    beginChallenge(input) {
      const config = requireEnabled();
      if (!config.callbackUrl) throw failure(503, 'CRM_SSO_UNAVAILABLE', 'CRM HTTPS callback is not configured');
      strictObject(input, ['storeKey', 'checkId', 'view']);
      const scope = destination(input);
      checkStore(config, scope.storeKey);
      const time = clock();
      prune(time); available(challenges, 'challenges');
      const challengeId = crypto.randomBytes(32).toString('base64url');
      const browserToken = crypto.randomBytes(32).toString('base64url');
      const expiresAt = time + CHALLENGE_TTL_MS;
      challenges.set(digest(challengeId), { browserHash: digest(browserToken), scope, expiresAt, issued: false });
      const callbackUrl = new URL(config.callbackUrl);
      callbackUrl.searchParams.set('challengeId', challengeId);
      // Navigation hints only: CRM must independently authorize its signed-in
      // subject. issueTicket checks all three fields against the saved scope.
      callbackUrl.searchParams.set('storeKey', scope.storeKey);
      callbackUrl.searchParams.set('view', scope.view);
      if (scope.checkId !== null) callbackUrl.searchParams.set('checkId', scope.checkId);
      return { challengeId, browserToken, callbackUrl: callbackUrl.href, expiresAt };
    },

    /** Only an authenticated machine principal can assert the CRM subject and issue a ticket. */
    issueTicket(identity, input) {
      const config = requireEnabled();
      if (verifyPrincipal(identity, config).kind !== 'client') throw failure(403, 'CRM_CLIENT_REQUIRED', 'CRM machine authentication required');
      strictObject(input, ['challengeId', 'subject', 'storeKey', 'checkId', 'view']);
      const scope = destination(input);
      checkStore(config, scope.storeKey);
      if (typeof input.subject !== 'string' || !input.subject || input.subject.length > 128
        || input.subject.trim() !== input.subject || /[\x00-\x1f\x7f]/.test(input.subject)) {
        throw failure(400, 'CRM_INVALID_SUBJECT', 'A stable CRM subject is required');
      }
      const time = clock();
      prune(time);
      const key = typeof input.challengeId === 'string' && TOKEN_RE.test(input.challengeId) ? digest(input.challengeId) : '';
      const challenge = challenges.get(key);
      if (!challenge) throw failure(401, 'CRM_CHALLENGE_INVALID', 'CRM handshake expired or invalid');
      if (challenge.issued) throw failure(409, 'CRM_CHALLENGE_USED', 'CRM handshake already has a ticket');
      if (Object.keys(scope).some((field) => scope[field] !== challenge.scope[field])) {
        throw failure(403, 'CRM_DESTINATION_MISMATCH', 'CRM ticket does not match the browser destination');
      }
      available(tickets, 'tickets');
      const ticket = crypto.randomBytes(32).toString('base64url');
      const expiresAt = Math.min(time + TICKET_TTL_MS, challenge.expiresAt);
      tickets.set(digest(ticket), { challengeKey: key, subject: input.subject, scope, expiresAt });
      challenge.issued = true;
      return { loginUrl: `${config.publicOrigin}/crm/sso#ticket=${ticket}`, expiresAt };
    },

    /** Consume once, synchronously, after validating the separate HttpOnly binding cookie. */
    exchangeTicket(ticket, browserToken) {
      const config = requireEnabled();
      const time = clock();
      prune(time);
      const key = typeof ticket === 'string' && TOKEN_RE.test(ticket) ? digest(ticket) : '';
      const record = tickets.get(key);
      const challenge = record ? challenges.get(record.challengeKey) : null;
      if (!record || !challenge || typeof browserToken !== 'string' || !TOKEN_RE.test(browserToken)
        || !equalSecret(digest(browserToken), challenge.browserHash)) {
        throw failure(401, 'CRM_TICKET_INVALID', 'CRM ticket or browser binding is expired or invalid');
      }
      checkStore(config, record.scope.storeKey);
      available(sessions, 'sessions');
      const sessionToken = crypto.randomBytes(32).toString('base64url');
      const sessionKey = digest(sessionToken);
      const expiresAt = time + SESSION_TTL_MS;
      const value = { kind: 'crm-readonly', clientId: config.clientId, subject: record.subject,
        ...record.scope, issuedAt: time, expiresAt };
      tickets.delete(key);
      challenges.delete(record.challengeKey);
      sessions.set(sessionKey, { scope: record.scope, value, expiresAt });
      const session = principal(value, { kind: 'session', version: config.version, key: sessionKey });
      return { sessionToken, session, expiresAt };
    },

    /** Returns only CRM claims; never compatible with a Dashboard session or role. */
    authenticateSession(sessionToken) {
      const config = requireEnabled();
      prune();
      const key = typeof sessionToken === 'string' && TOKEN_RE.test(sessionToken) ? digest(sessionToken) : '';
      const record = sessions.get(key);
      if (!record) throw failure(401, 'CRM_SESSION_INVALID', 'CRM session expired or invalid');
      checkStore(config, record.scope.storeKey);
      return principal(record.value, { kind: 'session', version: config.version, key });
    },

    /** Local CRM logout. No Dashboard cookie or user account is affected. */
    revokeSession(sessionToken) {
      settings();
      return typeof sessionToken === 'string' && TOKEN_RE.test(sessionToken) ? sessions.delete(digest(sessionToken)) : false;
    },

    /** Operational counts only, with expiration cleanup and no identity/token data. */
    stats() {
      settings(); prune();
      return { challenges: challenges.size, tickets: tickets.size, sessions: sessions.size };
    },
  };
}
