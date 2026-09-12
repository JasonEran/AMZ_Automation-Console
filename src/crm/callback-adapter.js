import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CHECK_IDS } from '../checks/registry.js';

const CHECKS = new Set(CHECK_IDS);
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const STORE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_RESPONSE_BYTES = 8192;
const ERRORS = {
  INPUT: [400, 'Invalid CRM callback request.'],
  METHOD: [405, 'Use GET for the CRM callback.'],
  LOGIN_REQUIRED: [401, 'Sign in to CRM, then start a new monitor handshake.'],
  STORE_FORBIDDEN: [403, 'This CRM user cannot read the requested store.'],
  AUTH_UNAVAILABLE: [503, 'CRM identity or store authorization is unavailable.'],
  CANCELLED: [408, 'The callback was cancelled. Start a new handshake from CRM.'],
  TIMEOUT: [504, 'The callback timed out. Start a new handshake from CRM.'],
  UPSTREAM_UNAVAILABLE: [502, 'Monitor authorization is unavailable. Start a new handshake from CRM.'],
  UPSTREAM_REJECTED: [502, 'Monitor authorization was rejected. Start a new handshake from CRM.'],
  UPSTREAM_INVALID: [502, 'Monitor authorization returned an invalid response.'],
  INTERNAL: [500, 'Unable to complete the CRM callback.'],
};

class CallbackFailure extends Error {
  constructor(kind) { super(ERRORS[kind][1]); this.kind = kind; }
}
const failure = kind => new CallbackFailure(kind);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validSubject = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const cancelBody = response => {
  if (response instanceof Response && response.body && !response.body.locked) response.body.cancel().catch(() => {});
};

function fixedHttps(value, originOnly = false) {
  let url;
  if (typeof value === 'string' && value && !/[\s\\]/.test(value)) {
    try { url = new URL(value); } catch { /* rejected below */ }
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || value.includes('?') || value.includes('#') || (originOnly && url.pathname !== '/')) {
    throw new TypeError('CRM callback configuration requires fixed HTTPS URLs.');
  }
  return originOnly ? url.origin : url;
}

function destination(request, callback) {
  if (!(request instanceof Request) || Buffer.byteLength(request.url, 'utf8') > 4096) throw failure('INPUT');
  if (request.method !== 'GET') throw failure('METHOD');
  const url = new URL(request.url);
  if (url.origin !== callback.origin || url.pathname !== callback.pathname || url.hash
    || url.username || url.password) throw failure('INPUT');
  const allowed = ['challengeId', 'storeKey', 'view', 'checkId'];
  const fields = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(fields, key)) throw failure('INPUT');
    fields[key] = value;
  }
  if (!TOKEN.test(fields.challengeId || '') || !STORE.test(fields.storeKey || '')
    || !['results', 'data'].includes(fields.view)
    || (Object.hasOwn(fields, 'checkId') && !CHECKS.has(fields.checkId))) throw failure('INPUT');
  return Object.freeze(fields);
}

/**
 * Server-only CRM callback adapter (Node >=22). Mount the returned Request ->
 * Promise<Response> handler at callbackUrl in the CRM backend, not at the monitor.
 * The framework must construct the Request URL from its trusted HTTPS deployment.
 *
 * identifyUser(request, {signal, requestId}) must validate the real CRM session
 * and return a plain identity object with an own, stable, non-PII `subject`, or
 * null for an unauthenticated user. It must not trust callback query parameters.
 * authorizeStore(identity, storeKey, {signal, requestId}) must independently check
 * the real CRM user/store mapping and return exactly true to authorize access.
 * Both hooks are required, perform read-only checks, and should honor signal.
 * A CRM HTTP page's localStorage token is not automatically sent to this callback.
 *
 * The total deadline includes both hooks, signing and response consumption. An
 * abort/timeout prevents later signing after a hook settles. A request already
 * sent may have issued a ticket even if its response is lost: never retry it;
 * start a new monitor handshake. The monitor still owns browser binding,
 * single-use tickets and per-store sessions. This adapter never exchanges tickets,
 * logs credentials/identity, changes CRM state, or performs automatic CRM login.
 * Clocks must be synchronized: returned expiry must be future and at most 60s away.
 */
export function createCrmCallbackHandler({ callbackUrl, monitorOrigin, apiToken,
  identifyUser, authorizeStore, fetchImpl = globalThis.fetch, timeoutMs = 5000, now = Date.now } = {}) {
  const callback = fixedHttps(callbackUrl);
  const origin = fixedHttps(monitorOrigin, true);
  if (typeof apiToken !== 'string' || apiToken.length < 32 || apiToken.length > 512
    || !/^[A-Za-z0-9._~+/-]+=*$/.test(apiToken)
    || typeof identifyUser !== 'function' || typeof authorizeStore !== 'function'
    || typeof fetchImpl !== 'function' || typeof now !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError('CRM callback requires valid credentials, explicit authentication hooks and a bounded timeout.');
  }
  const ticketUrl = `${origin}/api/crm/v1/sso/tickets`;

  return async function crmCallback(request) {
    const requestId = randomUUID();
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Request-Id': requestId, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' };
    const controller = new AbortController();
    const deadline = performance.now() + timeoutMs;
    let abortKind; let timer; let onAbort; let onExternalAbort; let upstream;
    const stop = kind => {
      if (!controller.signal.aborted) { abortKind = kind; controller.abort(); }
    };
    const active = () => {
      if (performance.now() >= deadline) stop('TIMEOUT');
      if (controller.signal.aborted) throw failure(abortKind || 'CANCELLED');
    };
    try {
      const scope = destination(request, callback);
      onExternalAbort = () => stop('CANCELLED');
      request.signal.addEventListener('abort', onExternalAbort, { once: true });
      if (request.signal.aborted) stop('CANCELLED');
      active();
      const aborted = new Promise((_, reject) => {
        onAbort = () => reject(failure(abortKind || 'CANCELLED'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      // A synchronous deadline check can abort before the first race is attached.
      aborted.catch(() => {});
      timer = setTimeout(() => stop('TIMEOUT'), Math.max(1, deadline - performance.now()));
      const wait = async operation => {
        active();
        const value = await Promise.race([Promise.resolve().then(() => { active(); return operation(); }), aborted]);
        active();
        return value;
      };
      const context = Object.freeze({ signal: controller.signal, requestId });
      let identity; let subject; let authorized;
      try {
        identity = await wait(() => identifyUser(request, context));
        if (identity === null) throw failure('LOGIN_REQUIRED');
        const descriptor = object(identity) && Object.getOwnPropertyDescriptor(identity, 'subject');
        if (!descriptor || !Object.hasOwn(descriptor, 'value') || !validSubject(descriptor.value)) throw failure('AUTH_UNAVAILABLE');
        subject = descriptor.value;
        authorized = await wait(() => authorizeStore(identity, scope.storeKey, context));
        if (Object.getOwnPropertyDescriptor(identity, 'subject')?.value !== subject) throw failure('AUTH_UNAVAILABLE');
      } catch (cause) {
        if (cause instanceof CallbackFailure) throw cause;
        throw failure('AUTH_UNAVAILABLE');
      }
      if (authorized !== true) throw failure('STORE_FORBIDDEN');
      active();
      try {
        upstream = await wait(async () => {
          const response = await fetchImpl(ticketUrl, {
            method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
            headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...scope, subject }), signal: controller.signal,
          });
          try { active(); } catch (cause) { cancelBody(response); throw cause; }
          return response;
        });
      } catch (cause) {
        if (cause instanceof CallbackFailure) throw cause;
        throw failure('UPSTREAM_UNAVAILABLE');
      }
      if (!(upstream instanceof Response) || upstream.redirected || (upstream.url && upstream.url !== ticketUrl)) {
        throw failure('UPSTREAM_INVALID');
      }
      if (upstream.status !== 201) throw failure('UPSTREAM_REJECTED');
      if (!/^application\/json(?:\s*;|$)/i.test(upstream.headers.get('content-type') || '') || !upstream.body) {
        throw failure('UPSTREAM_INVALID');
      }
      const length = upstream.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw failure('UPSTREAM_INVALID');
      const reader = upstream.body.getReader();
      let value;
      try {
        let size = 0; const chunks = [];
        while (true) {
          const chunk = await wait(() => reader.read());
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) throw failure('UPSTREAM_INVALID');
          size += chunk.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw failure('UPSTREAM_INVALID');
          chunks.push(chunk.value);
        }
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch (cause) {
        if (cause instanceof CallbackFailure) throw cause;
        throw failure('UPSTREAM_INVALID');
      } finally {
        reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const data = object(value) && value.data;
      if (value?.apiVersion !== '1.0' || !object(data) || data.singleUse !== true
        || typeof data.loginUrl !== 'string' || typeof data.expiresAt !== 'string') throw failure('UPSTREAM_INVALID');
      let login;
      try { login = new URL(data.loginUrl); } catch { throw failure('UPSTREAM_INVALID'); }
      if (!/^#ticket=[A-Za-z0-9_-]{43}$/.test(login.hash) || login.href !== `${origin}/crm/sso${login.hash}`) {
        throw failure('UPSTREAM_INVALID');
      }
      const expiresAt = Date.parse(data.expiresAt), time = now();
      if (!Number.isSafeInteger(time) || time < 0 || !Number.isFinite(expiresAt)
        || new Date(expiresAt).toISOString() !== data.expiresAt || expiresAt <= time || expiresAt > time + 60_000) {
        throw failure('UPSTREAM_INVALID');
      }
      active();
      return new Response(null, { status: 303, headers: { ...headers, Location: login.href } });
    } catch (cause) {
      const kind = cause instanceof CallbackFailure ? cause.kind : 'INTERNAL';
      const [status, detail] = ERRORS[kind];
      return Response.json({ type: 'about:blank', title: 'CRM callback could not complete', status,
        code: `CRM_CALLBACK_${kind}`, requestId, detail }, {
        status, headers: { ...headers, 'Content-Type': 'application/problem+json', ...(status === 405 ? { Allow: 'GET' } : {}) },
      });
    } finally {
      clearTimeout(timer);
      if (onExternalAbort) request.signal.removeEventListener('abort', onExternalAbort);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      controller.abort();
      cancelBody(upstream);
    }
  };
}
