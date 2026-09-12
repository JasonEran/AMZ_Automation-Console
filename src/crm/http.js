import crypto from 'node:crypto';
import fs from 'node:fs';
import { createCrmAccess } from '../lib/crm-access.js';
import { createCrmReadApi } from '../lib/crm-read-api.js';
import { CHECKS } from '../checks/registry.js';
import {
  CRM_PORTAL_HTML, CRM_PORTAL_SCRIPT, CRM_PORTAL_STYLE,
  CRM_SSO_HTML, CRM_SSO_SCRIPT,
} from '../web/crm-portal.js';
import { CRM_BRIDGE_SCRIPT, CRM_BRIDGE_STYLE, renderCrmBridge } from '../web/crm-bridge.js';

const API = '/api/crm/v1';
const SESSION_COOKIE = '__Host-amzguard_crm';
const BINDING_COOKIE = '__Host-amzguard_crm_binding';
const API_VERSION = '1.0';
const TITLES = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 413: 'Content Too Large',
  415: 'Unsupported Media Type', 421: 'Misdirected Request', 429: 'Too Many Requests',
  500: 'Internal Server Error', 503: 'Service Unavailable',
};
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const hash = value => crypto.createHash('sha256').update(value).digest('base64');

function cookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (Object.hasOwn(result, name)) throw error(400, 'CRM_DUPLICATE_COOKIE', 'Duplicate CRM cookie');
    if (![SESSION_COOKIE, BINDING_COOKIE].includes(name)) continue;
    try { result[name] = decodeURIComponent(part.slice(index + 1).trim()); }
    catch { throw error(400, 'CRM_INVALID_COOKIE', 'Invalid CRM cookie'); }
  }
  return result;
}

function cookie(name, token, seconds) {
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const content = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type, 'Content-Length': Buffer.byteLength(content),
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
  });
  res.end(content);
}

function html(res, body, script, style = CRM_PORTAL_STYLE) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'none'", `script-src 'sha256-${hash(script)}'`,
    `style-src 'sha256-${hash(style)}'`, "connect-src 'self'",
    "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'",
  ].join('; '));
  send(res, 200, body, 'text/html; charset=utf-8');
}

async function bodyJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
    throw error(415, 'CRM_JSON_REQUIRED', 'Content-Type must be application/json');
  }
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
    throw error(415, 'CRM_ENCODING_UNSUPPORTED', 'Compressed request bodies are not supported');
  }
  const limit = 8192;
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    req.resume();
    throw error(413, 'CRM_BODY_TOO_LARGE', 'Request body exceeds 8192 bytes');
  }
  const text = await new Promise((resolve, reject) => {
    let size = 0; let failed = false; const chunks = [];
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true; chunks.length = 0;
        reject(error(413, 'CRM_BODY_TOO_LARGE', 'Request body exceeds 8192 bytes'));
      } else chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('aborted', () => reject(error(400, 'CRM_BODY_INVALID', 'Request body was interrupted')));
    req.on('error', () => reject(error(400, 'CRM_BODY_INVALID', 'Request body was interrupted')));
  });
  let value;
  try { value = JSON.parse(text); } catch { throw error(400, 'CRM_JSON_INVALID', 'Invalid JSON body'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw error(400, 'CRM_JSON_INVALID', 'JSON body must be an object');
  }
  return value;
}

function exactFields(value, fields) {
  if (Object.keys(value).some(key => !fields.includes(key))) {
    throw error(400, 'CRM_UNKNOWN_FIELD', 'Unknown request field');
  }
}

/** Owns only /crm and /api/crm namespaces; never falls through to Dashboard auth. */
export function createCrmHttp({ outDir, stores, staleAfterMs, env = process.env,
  isSecureRequest, clientIp = req => req.socket.remoteAddress, now = Date.now } = {}) {
  const currentStores = () => typeof stores === 'function' ? stores() : stores;
  const access = createCrmAccess({ env, stores: currentStores, now });
  const rates = new Map();

  function limit(req, res, category, maximum) {
    const time = now();
    for (const [key, value] of rates) if (value.resetAt <= time) rates.delete(key);
    const key = `${category}:${String(clientIp(req) || 'unknown').slice(0, 100)}`;
    let row = rates.get(key);
    if (!row) {
      if (rates.size >= 5000) throw error(503, 'CRM_RATE_CAPACITY', 'Request limiter is at capacity');
      row = { count: 0, resetAt: time + 60_000 }; rates.set(key, row);
    }
    row.count++;
    res.setHeader('X-RateLimit-Limit', maximum);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maximum - row.count));
    if (row.count > maximum) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((row.resetAt - time) / 1000)));
      throw error(429, 'CRM_RATE_LIMITED', 'Too many requests; retry after the indicated interval');
    }
  }

  function canonical(req, settings) {
    if (!isSecureRequest(req)) throw error(400, 'CRM_HTTPS_REQUIRED', 'CRM access requires HTTPS');
    if (String(req.headers.host || '').toLowerCase() !== new URL(settings.publicOrigin).host.toLowerCase()) {
      throw error(421, 'CRM_ORIGIN_MISMATCH', 'Use the configured CRM API origin');
    }
  }

  function sameOrigin(req, settings) {
    const site = String(req.headers['sec-fetch-site'] || '');
    if (req.headers.origin !== settings.publicOrigin || (site && site !== 'same-origin')) {
      throw error(403, 'CRM_SAME_ORIGIN_REQUIRED', 'Same-origin request required');
    }
  }

  function method(req, res, expected) {
    if (req.method !== expected) {
      res.setHeader('Allow', expected);
      throw error(405, 'CRM_METHOD_NOT_ALLOWED', 'Method not allowed');
    }
  }

  function identity(req) {
    return req.headers.authorization !== undefined
      ? access.authenticateBearer(req)
      : access.authenticateSession(cookies(req)[SESSION_COOKIE]);
  }

  function scopes(principal) {
    const keys = principal.kind === 'crm-readonly' ? [principal.storeKey] : access.publicConfig().storeKeys;
    return keys.filter(key => { access.authorizeStore(principal, key); return true; });
  }

  return async function crmRequest(req, res, url) {
    const p = url.pathname;
    if (!(p === '/crm' || p.startsWith('/crm/') || p === '/api/crm' || p.startsWith('/api/crm/'))) return false;
    const requestId = crypto.randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const success = (status, body) => send(res, status, {
      apiVersion: API_VERSION, requestId, generatedAt: new Date(now()).toISOString(), ...body,
    });
    try {
      limit(req, res, p.startsWith('/api/') ? 'api' : 'browser', p.startsWith('/api/') ? 120 : 60);
      const settings = access.publicConfig();
      if (!settings.enabled) throw error(503, 'CRM_DISABLED', 'CRM read integration is not configured');
      canonical(req, settings);
      for (const key of url.searchParams.keys()) {
        if (/token|ticket|password|secret|authorization/i.test(key)) {
          throw error(400, 'CRM_QUERY_CREDENTIAL_REJECTED', 'Credentials must not appear in the query string');
        }
      }
      if (p === '/crm/sso/start' || p === '/crm/sso/bridge') {
        method(req, res, 'GET'); limit(req, res, 'start', 10);
        const fields = Object.fromEntries(url.searchParams);
        if ([...url.searchParams.keys()].length !== Object.keys(fields).length) {
          throw error(400, 'CRM_DUPLICATE_PARAMETER', 'Duplicate query parameter');
        }
        if (p === '/crm/sso/bridge') {
          const started = access.beginBridge(fields);
          res.setHeader('Set-Cookie', cookie(BINDING_COOKIE, started.browserToken, 120));
          // Only this purpose-built popup keeps its cross-origin opener. Other
          // pages retain their own headers and never receive this exception.
          res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
          html(res, renderCrmBridge(started), CRM_BRIDGE_SCRIPT, CRM_BRIDGE_STYLE); return true;
        }
        const started = access.beginChallenge(fields);
        res.writeHead(303, { Location: started.callbackUrl,
          'Set-Cookie': cookie(BINDING_COOKIE, started.browserToken, 120),
          'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end(); return true;
      }
      if (p === '/crm/sso') {
        method(req, res, 'GET');
        if (url.search) throw error(400, 'CRM_INVALID_QUERY', 'SSO completion does not accept query parameters');
        html(res, CRM_SSO_HTML, CRM_SSO_SCRIPT); return true;
      }
      if (p === `${API}/sso/tickets`) {
        method(req, res, 'POST'); limit(req, res, 'tickets', 20);
        if (url.search) throw error(400, 'CRM_INVALID_QUERY', 'Ticket issuance does not accept query parameters');
        const principal = access.authenticateBearer(req);
        const issued = access.issueTicket(principal, await bodyJson(req));
        success(201, { data: { loginUrl: issued.loginUrl, expiresAt: new Date(issued.expiresAt).toISOString(), singleUse: true } });
        return true;
      }
      if (p === '/crm/sso/exchange') {
        method(req, res, 'POST'); sameOrigin(req, settings); limit(req, res, 'exchange', 20);
        if (url.search) throw error(400, 'CRM_INVALID_QUERY', 'Exchange does not accept query parameters');
        const value = await bodyJson(req); exactFields(value, ['ticket']);
        const exchanged = access.exchangeTicket(value.ticket, cookies(req)[BINDING_COOKIE]);
        res.setHeader('Set-Cookie', [cookie(SESSION_COOKIE, exchanged.sessionToken, 1800), cookie(BINDING_COOKIE, '', 0)]);
        success(200, { data: { location: '/crm/', expiresAt: new Date(exchanged.expiresAt).toISOString() } });
        return true;
      }
      if (p === '/crm/logout') {
        method(req, res, 'POST'); sameOrigin(req, settings);
        if (url.search) throw error(400, 'CRM_INVALID_QUERY', 'Logout does not accept query parameters');
        const value = await bodyJson(req); exactFields(value, []);
        access.revokeSession(cookies(req)[SESSION_COOKIE]);
        res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, '', 0));
        success(200, { data: { loggedOut: true } }); return true;
      }
      if (['/crm', '/crm/', '/crm/session'].includes(p)) {
        method(req, res, 'GET');
        if (url.search) throw error(400, 'CRM_INVALID_QUERY', 'This page does not accept query parameters');
        const session = access.authenticateSession(cookies(req)[SESSION_COOKIE]);
        if (p === '/crm/session') {
          success(200, { data: { storeKey: session.storeKey, checkId: session.checkId, view: session.view,
            expiresAt: new Date(session.expiresAt).toISOString(), readOnly: true } });
        } else html(res, CRM_PORTAL_HTML, CRM_PORTAL_SCRIPT);
        return true;
      }
      if (p === API || p === `${API}/openapi.json`) {
        method(req, res, 'GET');
        if (url.search) throw error(400, 'CRM_INVALID_QUERY', 'Unknown query parameter');
        const principal = identity(req);
        const storeKeys = scopes(principal);
        if (p.endsWith('/openapi.json')) {
          send(res, 200, fs.readFileSync(new URL('../../docs/crm-openapi.json', import.meta.url), 'utf8'));
        } else success(200, { data: { version: API_VERSION, readOnly: true, storeKeys,
          resourceClasses: ['results', 'data'], intelligenceIncluded: false,
          checks: CHECKS.map(({ id, no, title, scope }) => ({ id, no, title, scope })),
          ssoAvailable: settings.ssoAvailable, ssoModes: settings.ssoModes, ticketTtlSeconds: 60, sessionTtlSeconds: 1800,
          staleAfterHours: staleAfterMs / 3_600_000 } });
        return true;
      }
      if (p.startsWith(`${API}/`)) {
        method(req, res, 'GET');
        const principal = identity(req);
        const api = createCrmReadApi({ outDir, stores: currentStores(), allowedStoreKeys: scopes(principal),
          staleAfterMs, now: () => new Date(now()) });
        const result = api.handle(url);
        if (result.status >= 400) {
          throw error(result.status, result.body.error?.code || 'CRM_REQUEST_FAILED',
            result.body.error?.message || 'Unable to read requested data');
        }
        success(result.status, result.body); return true;
      }
      throw error(404, 'CRM_NOT_FOUND', 'Unknown CRM route');
    } catch (cause) {
      const status = Object.hasOwn(TITLES, cause?.status) ? cause.status : 500;
      const code = typeof cause?.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(cause.code)
        ? cause.code : 'CRM_INTERNAL_ERROR';
      if (status === 401 && p.startsWith('/api/')) {
        res.setHeader('WWW-Authenticate', `Bearer realm="amzguard-crm"${req.headers.authorization ? ', error="invalid_token"' : ''}`);
      }
      // Only fixed, controlled validation text is returned. Never log the
      // incoming URL/body, Authorization, Cookie, subject, or ticket.
      send(res, status, { type: 'about:blank', title: TITLES[status], status, code, requestId,
        detail: status === 500 ? 'Internal server error' : cause.message,
        instance: p }, 'application/problem+json; charset=utf-8');
      return true;
    }
  };
}
