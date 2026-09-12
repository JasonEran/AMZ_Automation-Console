import assert from 'node:assert/strict';
import test from 'node:test';
import { createCrmAccess } from '../src/lib/crm-access.js';

function fixture(options = {}) {
  const env = {
    AMZGUARD_CRM_CLIENT_ID: 'crm-one',
    AMZGUARD_CRM_API_TOKEN: 'test-only-crm-token-with-at-least-32-characters',
    AMZGUARD_CRM_STORE_KEYS: 'US-01,US-02',
    AMZGUARD_CRM_PUBLIC_ORIGIN: 'https://monitor.example.test',
    AMZGUARD_CRM_CALLBACK_URL: 'https://crm.example.test/monitor-access',
    ...options.env,
  };
  const stores = [{ key: 'US-01', enabled: true }, { key: 'US-02', enabled: true }, { key: 'US-03', enabled: true }];
  let time = 1_800_000_000_000;
  const access = createCrmAccess({ env, stores: () => stores, now: () => time, limits: options.limits });
  const machine = () => access.authenticateBearer({ headers: { authorization: `Bearer ${env.AMZGUARD_CRM_API_TOKEN}` } });
  const dest = { storeKey: 'US-01', checkId: 'reviews', view: 'data' };
  function issue(overrides = {}) {
    const chosen = { ...dest, ...overrides };
    const challenge = access.beginChallenge(chosen);
    const issued = access.issueTicket(machine(), { ...chosen, challengeId: challenge.challengeId, subject: 'crm-user-42' });
    const ticket = new URLSearchParams(new URL(issued.loginUrl).hash.slice(1)).get('ticket');
    return { ...challenge, ...issued, ticket };
  }
  function login(overrides) {
    const issued = issue(overrides);
    return { ...issued, ...access.exchangeTicket(issued.ticket, issued.browserToken) };
  }
  return { env, stores, access, machine, dest, issue, login, advance: (ms) => { time += ms; }, now: () => time };
}

function rejects(fn, status, code) {
  assert.throws(fn, (error) => error.status === status && error.statusCode === status && error.code === code);
}

test('CRM is disabled without configuration and rejects partial or insecure configuration', () => {
  const disabled = createCrmAccess({ env: {}, stores: [] });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.publicConfig().ssoAvailable, false);
  rejects(() => disabled.authenticateBearer({ headers: {} }), 503, 'CRM_DISABLED');
  rejects(() => createCrmAccess({ env: { AMZGUARD_CRM_CLIENT_ID: 'crm' } }), 503, 'CRM_CONFIG_INVALID');
  for (const env of [
    { AMZGUARD_CRM_API_TOKEN: 'short' },
    { AMZGUARD_CRM_API_TOKEN: 'otherwise-long-token-but-with-a,comma' },
    { AMZGUARD_CRM_STORE_KEYS: '*' },
    { AMZGUARD_CRM_STORE_KEYS: 'US-01,US-01' },
    { AMZGUARD_CRM_STORE_KEYS: 'US-01,' },
    { AMZGUARD_CRM_PUBLIC_ORIGIN: 'http://monitor.example.test' },
    { AMZGUARD_CRM_PUBLIC_ORIGIN: 'https://monitor.example.test/path' },
    { AMZGUARD_CRM_PUBLIC_ORIGIN: 'https://user:password@monitor.example.test' },
    { AMZGUARD_CRM_CALLBACK_URL: 'http://crm.example.test/path' },
    { AMZGUARD_CRM_CALLBACK_URL: 'https://crm.example.test/path?redirect=anything' },
    { AMZGUARD_CRM_CALLBACK_URL: 'https://crm.example.test/path#fragment' },
  ]) rejects(() => fixture({ env }), 503, 'CRM_CONFIG_INVALID');
});

test('missing HTTPS callback disables only SSO while machine access remains usable', () => {
  const f = fixture({ env: { AMZGUARD_CRM_CALLBACK_URL: '' } });
  assert.equal(f.access.enabled, true);
  assert.equal(f.access.publicConfig().ssoAvailable, false);
  assert.deepEqual(f.access.authorizeStore(f.machine(), 'US-01'), { clientId: 'crm-one', storeKey: 'US-01' });
  rejects(() => f.access.beginChallenge(f.dest), 503, 'CRM_SSO_UNAVAILABLE');
});

test('machine authentication accepts only the dedicated Authorization bearer', () => {
  const f = fixture();
  for (const req of [
    { headers: {} },
    { headers: { authorization: 'Bearer wrong-token' } },
    { headers: { authorization: `Basic ${f.env.AMZGUARD_CRM_API_TOKEN}` } },
    { headers: { cookie: `amzguard_session=${f.env.AMZGUARD_CRM_API_TOKEN}` } },
    { headers: { 'x-ingest-token': f.env.AMZGUARD_CRM_API_TOKEN } },
    { headers: { authorization: [`Bearer ${f.env.AMZGUARD_CRM_API_TOKEN}`] } },
    { headers: { authorization: `Bearer ${f.env.AMZGUARD_CRM_API_TOKEN},other` } },
    { headers: {}, url: `/?token=${f.env.AMZGUARD_CRM_API_TOKEN}` },
  ]) rejects(() => f.access.authenticateBearer(req), 401, 'CRM_AUTH_REQUIRED');
  assert.equal(f.machine().kind, 'crm-client');
  rejects(() => f.access.authorizeStore({ kind: 'crm-client', clientId: 'crm-one' }, 'US-01'), 401, 'CRM_AUTH_REQUIRED');
  assert.ok(Object.isFrozen(f.machine().storeKeys));
});

test('complete handshake fixes callback, browser binding, destination and single-store session', () => {
  const f = fixture();
  const issued = f.issue();
  const callback = new URL(issued.callbackUrl);
  assert.equal(callback.origin + callback.pathname, f.env.AMZGUARD_CRM_CALLBACK_URL);
  assert.deepEqual([...callback.searchParams.keys()], ['challengeId', 'storeKey', 'view', 'checkId']);
  assert.equal(callback.searchParams.get('challengeId'), issued.challengeId);
  assert.equal(callback.searchParams.get('storeKey'), 'US-01');
  assert.equal(callback.searchParams.get('view'), 'data');
  assert.equal(callback.searchParams.get('checkId'), 'reviews');
  assert.doesNotMatch(issued.callbackUrl, new RegExp(issued.browserToken));
  assert.equal(new URL(issued.loginUrl).origin + new URL(issued.loginUrl).pathname, 'https://monitor.example.test/crm/sso');
  assert.equal(new URL(issued.loginUrl).search, '');
  assert.equal(issued.expiresAt, f.now() + 60_000);
  const exchanged = f.access.exchangeTicket(issued.ticket, issued.browserToken);
  assert.deepEqual(exchanged.session, {
    kind: 'crm-readonly', clientId: 'crm-one', subject: 'crm-user-42',
    storeKey: 'US-01', checkId: 'reviews', view: 'data', issuedAt: f.now(), expiresAt: f.now() + 1_800_000,
  });
  assert.equal(exchanged.session.roles, undefined);
  assert.equal(exchanged.session.username, undefined);
  assert.deepEqual(f.access.authenticateSession(exchanged.sessionToken), exchanged.session);
  assert.deepEqual(f.access.authorizeStore(exchanged.session, 'US-01'), { clientId: 'crm-one', storeKey: 'US-01' });
  rejects(() => f.access.authorizeStore(exchanged.session, 'US-02'), 403, 'CRM_STORE_FORBIDDEN');
  assert.deepEqual(f.access.stats(), { challenges: 0, tickets: 0, sessions: 1 });
});

test('unknown request fields and caller-controlled redirects or roles are rejected', () => {
  const f = fixture();
  for (const field of ['redirect', 'redirect_uri', 'callbackUrl', 'returnUrl', 'role', 'roles', 'username', 'expiresAt']) {
    rejects(() => f.access.beginChallenge({ ...f.dest, [field]: 'https://other.example.test' }), 400, 'CRM_INVALID_INPUT');
    const challenge = f.access.beginChallenge(f.dest);
    rejects(() => f.access.issueTicket(f.machine(), {
      ...f.dest, challengeId: challenge.challengeId, subject: 'user', [field]: 'admin',
    }), 400, 'CRM_INVALID_INPUT');
  }
  for (const value of [null, [], 'value', Object.create({ role: 'admin' })]) {
    rejects(() => f.access.beginChallenge(value), 400, 'CRM_INVALID_INPUT');
  }
});

test('known checks, explicit views and exact store keys are validated', () => {
  const f = fixture();
  for (const checkId of ['', 'unknown-check', 1]) {
    rejects(() => f.access.beginChallenge({ ...f.dest, checkId }), 400, 'CRM_INVALID_CHECK');
  }
  for (const view of ['', 'admin', undefined, null]) {
    rejects(() => f.access.beginChallenge({ ...f.dest, view }), 400, 'CRM_INVALID_VIEW');
  }
  for (const storeKey of ['', '*', ' US-01', '../US-01']) {
    rejects(() => f.access.beginChallenge({ ...f.dest, storeKey }), 400, 'CRM_INVALID_STORE');
  }
  for (const storeKey of ['US-03', 'us-01', 'missing']) {
    rejects(() => f.access.beginChallenge({ ...f.dest, storeKey }), 403, 'CRM_STORE_FORBIDDEN');
  }
  const login = f.login({ checkId: undefined, view: 'results' });
  assert.equal(login.session.checkId, null);
  assert.equal(new URL(login.callbackUrl).searchParams.has('checkId'), false);
});

test('ticket issuance must match the browser-selected store, check and view', () => {
  const f = fixture();
  const challenge = f.access.beginChallenge(f.dest);
  for (const mismatch of [{ storeKey: 'US-02' }, { checkId: 'feedback' }, { view: 'results' }]) {
    rejects(() => f.access.issueTicket(f.machine(), {
      ...f.dest, ...mismatch, challengeId: challenge.challengeId, subject: 'user',
    }), 403, 'CRM_DESTINATION_MISMATCH');
  }
  const body = { ...f.dest, challengeId: challenge.challengeId, subject: 'user' };
  f.access.issueTicket(f.machine(), body);
  rejects(() => f.access.issueTicket(f.machine(), body), 409, 'CRM_CHALLENGE_USED');
});

test('CRM subject is mandatory bounded data, and browser identities cannot issue tickets', () => {
  const f = fixture();
  const challenge = f.access.beginChallenge(f.dest);
  for (const subject of ['', null, 123, 'a\nb', ' leading', 'a'.repeat(129)]) {
    rejects(() => f.access.issueTicket(f.machine(), { ...f.dest, challengeId: challenge.challengeId, subject }), 400, 'CRM_INVALID_SUBJECT');
  }
  const login = f.login();
  rejects(() => f.access.issueTicket(login.session, { ...f.dest, challengeId: challenge.challengeId, subject: 'user' }), 403, 'CRM_CLIENT_REQUIRED');
});

test('a leaked ticket cannot be exchanged without its browser cookie', () => {
  const f = fixture();
  const first = f.issue();
  const other = f.issue();
  for (const binding of [undefined, '', first.challengeId, other.browserToken]) {
    rejects(() => f.access.exchangeTicket(first.ticket, binding), 401, 'CRM_TICKET_INVALID');
  }
  const legitimate = f.access.exchangeTicket(first.ticket, first.browserToken);
  assert.equal(legitimate.session.storeKey, 'US-01');
  rejects(() => f.access.authenticateSession(first.ticket), 401, 'CRM_SESSION_INVALID');
  rejects(() => f.access.authenticateSession(first.browserToken), 401, 'CRM_SESSION_INVALID');
});

test('single-use exchange remains atomic for concurrent callers', async () => {
  const f = fixture();
  const issued = f.issue();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => Promise.resolve().then(() =>
    f.access.exchangeTicket(issued.ticket, issued.browserToken))));
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'CRM_TICKET_INVALID').length, 7);
  assert.deepEqual(f.access.stats(), { challenges: 0, tickets: 0, sessions: 1 });
});

test('challenge and ticket expiration use exact boundaries without extending the handshake', () => {
  const f = fixture();
  const challenge = f.access.beginChallenge(f.dest);
  f.advance(120_000);
  rejects(() => f.access.issueTicket(f.machine(), { ...f.dest, challengeId: challenge.challengeId, subject: 'user' }), 401, 'CRM_CHALLENGE_INVALID');
  const issued = f.issue();
  f.advance(60_000);
  rejects(() => f.access.exchangeTicket(issued.ticket, issued.browserToken), 401, 'CRM_TICKET_INVALID');
  const late = f.access.beginChallenge(f.dest);
  f.advance(119_000);
  const ticket = f.access.issueTicket(f.machine(), { ...f.dest, challengeId: late.challengeId, subject: 'user' });
  assert.equal(ticket.expiresAt, f.now() + 1000);
  f.advance(1000);
  rejects(() => f.access.exchangeTicket(new URLSearchParams(new URL(ticket.loginUrl).hash.slice(1)).get('ticket'), late.browserToken), 401, 'CRM_TICKET_INVALID');
  assert.deepEqual(f.access.stats(), { challenges: 0, tickets: 0, sessions: 0 });
});

test('browser sessions expire after 30 minutes, without sliding renewal', () => {
  const f = fixture();
  const login = f.login();
  f.advance(1_799_999);
  assert.equal(f.access.authenticateSession(login.sessionToken).expiresAt, login.expiresAt);
  f.advance(1);
  rejects(() => f.access.authenticateSession(login.sessionToken), 401, 'CRM_SESSION_INVALID');
  rejects(() => f.access.authorizeStore(login.session, 'US-01'), 401, 'CRM_SESSION_INVALID');
});

test('disabled, removed or ambiguous stores are denied at every authorization boundary', () => {
  const f = fixture();
  const machine = f.machine();
  const login = f.login();
  const issued = f.issue();
  f.stores[0].enabled = false;
  rejects(() => f.access.authorizeStore(machine, 'US-01'), 403, 'CRM_STORE_FORBIDDEN');
  rejects(() => f.access.authenticateSession(login.sessionToken), 403, 'CRM_STORE_FORBIDDEN');
  rejects(() => f.access.exchangeTicket(issued.ticket, issued.browserToken), 403, 'CRM_STORE_FORBIDDEN');
  assert.deepEqual(f.access.publicConfig().storeKeys, ['US-02']);
  f.stores.splice(0, 1);
  rejects(() => f.access.authenticateSession(login.sessionToken), 403, 'CRM_STORE_FORBIDDEN');
  f.stores.push({ key: 'US-02', enabled: true });
  rejects(() => f.access.authorizeStore(machine, 'US-02'), 403, 'CRM_STORE_FORBIDDEN');
});

test('key rotation and scope changes invalidate all existing identities and browser state', () => {
  for (const change of [
    { AMZGUARD_CRM_API_TOKEN: 'a-new-test-only-token-with-at-least-32-characters' },
    { AMZGUARD_CRM_STORE_KEYS: 'US-02' },
    { AMZGUARD_CRM_CLIENT_ID: 'crm-other' },
    { AMZGUARD_CRM_PUBLIC_ORIGIN: 'https://other-monitor.example.test' },
  ]) {
    const f = fixture();
    const machine = f.machine();
    const login = f.login();
    const issued = f.issue();
    Object.assign(f.env, change);
    rejects(() => f.access.authenticateSession(login.sessionToken), 401, 'CRM_SESSION_INVALID');
    rejects(() => f.access.authorizeStore(machine, 'US-01'), 401, 'CRM_AUTH_REQUIRED');
    rejects(() => f.access.exchangeTicket(issued.ticket, issued.browserToken), 401, 'CRM_TICKET_INVALID');
    assert.deepEqual(f.access.stats(), { challenges: 0, tickets: 0, sessions: 0 });
  }
});

test('invalid configuration clears old sessions before configuration is restored', () => {
  const f = fixture();
  const login = f.login();
  const oldOrigin = f.env.AMZGUARD_CRM_PUBLIC_ORIGIN;
  f.env.AMZGUARD_CRM_PUBLIC_ORIGIN = 'http://monitor.example.test';
  rejects(() => f.access.authenticateSession(login.sessionToken), 503, 'CRM_CONFIG_INVALID');
  f.env.AMZGUARD_CRM_PUBLIC_ORIGIN = oldOrigin;
  rejects(() => f.access.authenticateSession(login.sessionToken), 401, 'CRM_SESSION_INVALID');
});

test('a new access instance cannot accept prior tickets or sessions', () => {
  const f = fixture();
  const login = f.login();
  const issued = f.issue();
  const restarted = createCrmAccess({ env: f.env, stores: f.stores, now: f.now });
  rejects(() => restarted.authenticateSession(login.sessionToken), 401, 'CRM_SESSION_INVALID');
  rejects(() => restarted.exchangeTicket(issued.ticket, issued.browserToken), 401, 'CRM_TICKET_INVALID');
});

test('logout revokes even a previously authenticated principal and leaves other sessions active', () => {
  const f = fixture();
  const first = f.login();
  const second = f.login();
  const oldPrincipal = f.access.authenticateSession(first.sessionToken);
  assert.equal(f.access.revokeSession(first.sessionToken), true);
  assert.equal(f.access.revokeSession(first.sessionToken), false);
  rejects(() => f.access.authorizeStore(oldPrincipal, 'US-01'), 401, 'CRM_SESSION_INVALID');
  rejects(() => f.access.authenticateSession(first.sessionToken), 401, 'CRM_SESSION_INVALID');
  assert.equal(f.access.authenticateSession(second.sessionToken).storeKey, 'US-01');
});

test('challenge, ticket and session capacities fail closed without evicting active entries', () => {
  const limitedChallenges = fixture({ limits: { challenges: 1 } });
  limitedChallenges.access.beginChallenge(limitedChallenges.dest);
  rejects(() => limitedChallenges.access.beginChallenge(limitedChallenges.dest), 503, 'CRM_CAPACITY');
  limitedChallenges.advance(120_000);
  assert.ok(limitedChallenges.access.beginChallenge(limitedChallenges.dest).challengeId);

  const limitedTickets = fixture({ limits: { tickets: 1 } });
  const first = limitedTickets.issue();
  rejects(() => limitedTickets.issue(), 503, 'CRM_CAPACITY');
  assert.ok(limitedTickets.access.exchangeTicket(first.ticket, first.browserToken).sessionToken);

  const limitedSessions = fixture({ limits: { sessions: 1 } });
  const login = limitedSessions.login();
  const next = limitedSessions.issue();
  rejects(() => limitedSessions.access.exchangeTicket(next.ticket, next.browserToken), 503, 'CRM_CAPACITY');
  assert.ok(limitedSessions.access.authenticateSession(login.sessionToken));
  limitedSessions.access.revokeSession(login.sessionToken);
  assert.ok(limitedSessions.access.exchangeTicket(next.ticket, next.browserToken).sessionToken);
});

test('public configuration and statistics contain no token, callback or user identity', () => {
  const f = fixture();
  const login = f.login();
  const serialized = JSON.stringify({ config: f.access.publicConfig(), stats: f.access.stats() });
  for (const secret of [f.env.AMZGUARD_CRM_API_TOKEN, f.env.AMZGUARD_CRM_CALLBACK_URL,
    login.browserToken, login.ticket, login.sessionToken, 'crm-user-42']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('popup mode is optional and accepts only one exact external HTTP or HTTPS origin', () => {
  assert.deepEqual(createCrmAccess({ env: {} }).publicConfig().ssoModes, []);
  const redirect = fixture();
  assert.deepEqual(redirect.access.publicConfig().ssoModes, ['redirect']);
  rejects(() => redirect.access.beginBridge({ ...redirect.dest, requestId: 'R'.repeat(43) }), 503, 'CRM_BRIDGE_UNAVAILABLE');
  for (const origin of ['http://crm.example.test', 'https://crm.example.test:8443']) {
    const f = fixture({ env: { AMZGUARD_CRM_CALLBACK_URL: '', AMZGUARD_CRM_BRIDGE_ORIGIN: origin } });
    assert.deepEqual(f.access.publicConfig().ssoModes, ['popup']);
    assert.equal(f.access.publicConfig().ssoAvailable, true);
    rejects(() => f.access.beginChallenge(f.dest), 503, 'CRM_SSO_UNAVAILABLE');
    assert.equal(f.access.beginBridge({ ...f.dest, requestId: 'R'.repeat(43) }).bridgeOrigin, origin);
  }
  for (const origin of ['*', 'http://*.example.test', 'http://crm.example.test/', 'http://crm.example.test/path',
    'http://user:pass@crm.example.test', 'http://crm.example.test?x', 'http://crm.example.test#x',
    'http://crm.example.test?', 'http://crm.example.test#', 'http://crm.example.test\\evil',
    ' http://crm.example.test', 'http://crm.example.test ', 'http://crm.\texample.test',
    'http://crm.example.test\n', 'http://CRM.example.test', 'http://crm.example.test:80',
    'https://monitor.example.test', '//crm.example.test', 'file:///crm', 'null', null, 123]) {
    rejects(() => fixture({ env: { AMZGUARD_CRM_BRIDGE_ORIGIN: origin } }), 503, 'CRM_CONFIG_INVALID');
  }
  rejects(() => createCrmAccess({ env: { AMZGUARD_CRM_BRIDGE_ORIGIN: 'http://crm.example.test' } }), 503, 'CRM_CONFIG_INVALID');
});

test('popup challenges retain exact destination, separate browser binding, expiry and one-time exchange', () => {
  const f = fixture({ env: { AMZGUARD_CRM_BRIDGE_ORIGIN: 'http://crm.example.test' } });
  assert.deepEqual(f.access.publicConfig().ssoModes, ['redirect', 'popup']);
  const started = f.access.beginBridge({ ...f.dest, requestId: 'R'.repeat(43) });
  assert.equal(started.requestId, 'R'.repeat(43));
  assert.equal(started.expiresAt, f.now() + 120_000);
  for (const mismatch of [{ storeKey: 'US-02' }, { view: 'results' }, { checkId: 'feedback' }]) {
    rejects(() => f.access.issueTicket(f.machine(), { ...f.dest, ...mismatch, subject: 'user', challengeId: started.challengeId }), 403, 'CRM_DESTINATION_MISMATCH');
  }
  const issued = f.access.issueTicket(f.machine(), { ...f.dest, subject: 'user', challengeId: started.challengeId });
  const ticket = issued.loginUrl.split('#ticket=')[1];
  rejects(() => f.access.exchangeTicket(ticket, 'B'.repeat(43)), 401, 'CRM_TICKET_INVALID');
  const session = f.access.exchangeTicket(ticket, started.browserToken);
  assert.equal(session.session.storeKey, 'US-01');
  assert.equal(Object.hasOwn(session.session, 'requestId'), false, 'public correlation does not expand ticket/session fields');
  rejects(() => f.access.authorizeStore(session.session, 'US-02'), 403, 'CRM_STORE_FORBIDDEN');
  rejects(() => f.access.exchangeTicket(ticket, started.browserToken), 401, 'CRM_TICKET_INVALID');
  const expired = f.access.beginBridge({ storeKey: 'US-01', view: 'results', requestId: 'S'.repeat(43) });
  assert.equal(expired.checkId, null);
  f.advance(120_000);
  rejects(() => f.access.issueTicket(f.machine(), { storeKey: 'US-01', view: 'results', subject: 'user', challengeId: expired.challengeId }), 401, 'CRM_CHALLENGE_INVALID');
});

test('popup rejects unknown fields, invalid correlation and unauthorized destination without allocating challenges', () => {
  const f = fixture({ env: { AMZGUARD_CRM_BRIDGE_ORIGIN: 'http://crm.example.test' } });
  const input = { ...f.dest, requestId: 'R'.repeat(43) };
  for (const requestId of [undefined, '', 'R'.repeat(42), 'R'.repeat(44), 'x'.repeat(42) + '/', [], 1]) {
    rejects(() => f.access.beginBridge({ ...input, requestId }), 400, 'CRM_INVALID_REQUEST_ID');
  }
  for (const field of ['callbackUrl', 'openerOrigin', 'role', 'ticket', 'expiresAt']) {
    rejects(() => f.access.beginBridge({ ...input, [field]: 'untrusted' }), 400, 'CRM_INVALID_INPUT');
  }
  rejects(() => f.access.beginBridge({ ...input, storeKey: 'US-03' }), 403, 'CRM_STORE_FORBIDDEN');
  rejects(() => f.access.beginBridge({ ...input, checkId: 'intelligence' }), 400, 'CRM_INVALID_CHECK');
  rejects(() => f.access.beginBridge({ ...input, view: 'admin' }), 400, 'CRM_INVALID_VIEW');
  assert.deepEqual(f.access.stats(), { challenges: 0, tickets: 0, sessions: 0 });
});

test('adding, rotating, removing or invalidating bridge configuration clears old authentication state', () => {
  for (const bridge of ['http://other-crm.example.test', '', 'http://crm.example.test/path']) {
    const f = fixture({ env: { AMZGUARD_CRM_BRIDGE_ORIGIN: 'http://crm.example.test' } });
    const login = f.login(), pending = f.issue();
    f.env.AMZGUARD_CRM_BRIDGE_ORIGIN = bridge;
    if (bridge.endsWith('/path')) rejects(() => f.access.publicConfig(), 503, 'CRM_CONFIG_INVALID');
    else f.access.publicConfig();
    f.env.AMZGUARD_CRM_BRIDGE_ORIGIN = 'http://crm.example.test';
    rejects(() => f.access.authenticateSession(login.sessionToken), 401, 'CRM_SESSION_INVALID');
    rejects(() => f.access.exchangeTicket(pending.ticket, pending.browserToken), 401, 'CRM_TICKET_INVALID');
  }
  const f = fixture(); const login = f.login();
  f.env.AMZGUARD_CRM_BRIDGE_ORIGIN = 'http://crm.example.test';
  rejects(() => f.access.authenticateSession(login.sessionToken), 401, 'CRM_SESSION_INVALID');
});
