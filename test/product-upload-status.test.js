import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { normalizeProductUploadStatusRow as normalize } from '../src/lib/product-upload-status.js';
import { ZiniaoWebDriver } from '../src/lib/ziniao-webdriver.js';

const split = (name, submitted, success) => ({ processingState: { name },
  processingStatistics: { numRecordsSubmitted: submitted, numRecordsSuccessful: success } });
const row = (...splits) => ({ feedIdentifier: { batchId: '123456789012' }, splitStatuses: splits });

test('single completed upload requires explicit positive, matching record counts', () => {
  for (const state of ['DONE', 'PUBLISHED']) {
    const result = normalize(row(split(state, 1, 1)));
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.processingState, state);
    assert.deepEqual(result.counts, { submitted: 1, success: 1, failed: null, warning: null });
    assert.equal(result.version, 1);
    assert.equal(result.source, 'AMAZON_UPLOAD_STATUS_ROW');
  }
  assert.equal(normalize(row(split('DONE', '2', '2'))).status, 'COMPLETED');
});

test('completed zero data, absent statistics and inconsistent statistics never imply success', () => {
  for (const candidate of [split('DONE', 0, 0), split('DONE'), { processingState: { name: 'DONE' } }]) {
    assert.equal(normalize(row(candidate)).status, 'UNKNOWN');
  }
  const conflict = normalize(row(split('DONE', 1, 2)));
  assert.equal(conflict.status, 'UNKNOWN');
  assert.match(conflict.statusText, /冲突/);
  assert.equal(conflict.counts.success, null);
  const partial = normalize(row(split('DONE', 3, 1)));
  assert.equal(partial.status, 'COMPLETED_WITH_WARNINGS');
  assert.deepEqual(partial.counts, { submitted: 3, success: 1, failed: null, warning: null });
});

test('counts reject coercion, rounding, unsafe integers and localized numbers', () => {
  for (const invalid of [true, false, '', ' ', '01', '1.0', '1e2', '1,000', '-1', -1,
    1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '9007199254740992', {}, []]) {
    const result = normalize(row(split('DONE', invalid, invalid)));
    assert.equal(result.status, 'UNKNOWN', String(invalid));
    assert.equal(result.counts.submitted, null);
    assert.equal(result.counts.success, null);
  }
  assert.equal(normalize(row(split('DONE', 10000000, 10000000))).status, 'COMPLETED');
  for (const value of [10000001, '10000001', Number.MAX_SAFE_INTEGER]) {
    for (const state of ['DONE', 'IN_PROGRESS']) {
      const result = normalize(row(split(state, value, value)));
      assert.equal(result.status, 'UNKNOWN');
      assert.equal(result.counts.submitted, null);
      assert.equal(result.counts.success, null);
    }
  }
});

test('in-progress and action-required results never infer failed counts or completion', () => {
  for (const stats of [[4, 1], [1, 1], [undefined, undefined]]) {
    const result = normalize(row(split('IN_PROGRESS', ...stats)));
    assert.equal(result.status, 'PROCESSING');
    assert.equal(result.counts.failed, null);
  }
  const required = normalize(row(split('ACTION_REQUIRED', 3, 1)));
  assert.equal(required.status, 'UNKNOWN');
  assert.match(required.statusText, /要求进一步处理/);
  assert.equal(required.counts.failed, null);
});

test('explicit failure, draft and no-data states retain their distinct meanings', () => {
  for (const state of ['FAILED', 'REJECTED']) {
    const result = normalize(row(split(state, 5, 0)));
    assert.equal(result.status, 'FAILED');
    assert.equal(result.counts.failed, null);
  }
  assert.equal(normalize(row(split('SAVED_AS_DRAFTS', 1, 1))).status, 'RECEIVED');
  assert.equal(normalize(row(split('NO_DATA_FOUND', 1, 1))).status, 'UNKNOWN');
});

test('multiple splits never produce an unproven aggregate or complete verdict', () => {
  for (const splits of [[split('DONE', 1, 1), split('DONE', 1, 1)],
    [split('DONE', 1, 1), split('PUBLISHED', 1, 1)],
    [split('DONE', 1, 1), split('FAILED', 1, 0)]]) {
    const result = normalize(row(...splits));
    assert.equal(result.status, 'UNKNOWN');
    assert.deepEqual(result.counts, { submitted: null, success: null, failed: null, warning: null });
  }
  const pending = normalize(row(split('DONE', 1, 1), split('IN_PROGRESS', 1, 0)));
  assert.equal(pending.status, 'PROCESSING');
  assert.equal(pending.processingState, 'MIXED');
  assert.equal(normalize(row(split('FAILED'), split('REJECTED'))).status, 'FAILED');
});

test('unsupported and legacy status formats remain unknown', () => {
  for (const candidate of [null, [], {}, row(), row(null), row(split('done', 1, 1)),
    { batchId: '123456789012', processingState: { name: 'DONE' }, processingStatistics: { numRecordsSubmitted: 1, numRecordsSuccessful: 1 } },
    row(split('NEW_STATE', 1, 1)), row(split('DONE', 1, 1), split('NEW_STATE', 1, 1))]) {
    assert.equal(normalize(candidate).status, 'UNKNOWN');
  }
  assert.equal(normalize(row(split('NEW_STATE', 1, 1))).processingState, 'NEW_STATE');
  assert.equal(normalize(row(split('done', 1, 1))).processingState, null);
});

test('batch identity conflicts or absent identifiers cannot yield a completed result', () => {
  const candidate = row(split('DONE', 1, 1));
  assert.equal(normalize({ ...candidate, batchId: '999' }).status, 'UNKNOWN');
  assert.equal(normalize({ ...candidate, batchId: '123456789012' }).status, 'COMPLETED');
  assert.equal(normalize({ ...candidate, feedIdentifier: undefined }).status, 'UNKNOWN');
  assert.equal(normalize({ ...candidate, batchId: 123, feedIdentifier: undefined }).batchId, null);
  assert.equal(normalize({ ...candidate, batchId: 'fixture-batch_2.a:3', feedIdentifier: undefined }).status, 'COMPLETED');
  for (const batchId of ['contains space', '/path', 'x'.repeat(161)]) {
    assert.equal(normalize({ ...candidate, batchId, feedIdentifier: undefined }).status, 'UNKNOWN');
  }
});

test('submission dates use only valid ISO source timestamps or numeric milliseconds', () => {
  const candidate = row(split('DONE', 1, 1));
  for (const value of ['2026-09-14T10:20:30Z', '2026-09-14T10:20:30', '2026-09-14T18:20:30+08:00', 1789381230000]) {
    assert.equal(normalize({ ...candidate, submissionDate: value }).submittedAt, '2026-09-14T10:20:30.000Z');
  }
  for (const value of ['Sep 14, 2026 10:20 AM', '2026-09-14', '2026-02-30T10:20:30Z',
    '2026-09-14T24:00:00Z', true, '1789381230000', Infinity, -1]) {
    assert.equal(normalize({ ...candidate, submissionDate: value }).submittedAt, null);
  }
});

test('normalization leaves the row untouched and excludes confidential action and account fields', () => {
  const candidate = { ...row(split('DONE', 1, 1)), originalFileName: 'private-product.xlsx',
    merchantId: 'private-account', csrfToken: 'private-csrf',
    actions: [{ link: 'https://example.invalid/private-report', requestBody: 'private-body' }] };
  candidate.splitStatuses[0].actions = candidate.actions;
  candidate.splitStatuses[0].processingState.pantherId = 'private-status-text';
  const before = JSON.stringify(candidate);
  const result = normalize(candidate);
  assert.equal(JSON.stringify(candidate), before);
  assert.doesNotMatch(JSON.stringify(result), /private-|originalFileName|merchantId|csrf|actions|https:/);
});

const BULK_URL = 'https://sellercentral.amazon.com/product-search/bulk';
const STATUS_URL = `${BULK_URL}/status`;

// Construct only the prototype: the real transport constructor loads credentials.
// Page scripts execute against a synthetic DOM, never against a browser or API.
function processingFixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });
  const state = { url: options.initialUrl || BULK_URL, navigations: [], scripts: 0, gates: 0 };
  function element(id, content = '') {
    return { innerText: content, textContent: content, hidden: false, parentElement: null,
      getClientRects() { return this.hidden ? [] : [{}]; }, getRootNode() { return {}; },
      hasAttribute(name) { return name === 'data-cy-id' && Boolean(id); },
      getAttribute(name) { return name === 'data-cy-id' ? id : null; },
      querySelectorAll() { return []; } };
  }
  const batchCell = element('feed-batch-id:row-2', options.domBatchId ?? '123456789012');
  const fileCell = element('file-name-and-date:row-2');
  const name = element(null, options.domFileName ?? 'payload.xlsx');
  fileCell.querySelectorAll = selector => selector === '.file-name-content > b' ? [name] : [];
  const countCell = element('feed-records-submitted-count:row-2', options.domCounts ?? '1 / 1');
  const statusCell = element('status-indicator:row-2', '处理完成');
  const badge = element(null, '处理完成');
  badge.tagName = 'KAT-BADGE';
  badge.label = options.badgeLabel ?? '处理完成';
  badge.type = options.badgeType ?? 'success';
  badge.getAttribute = attribute => ({ label: badge.label, type: badge.type })[attribute] ?? null;
  statusCell.querySelectorAll = selector => selector === 'kat-badge'
    ? options.noBadge ? [] : options.multipleBadges ? [badge, badge] : [badge] : [];
  const cells = [batchCell, fileCell, countCell, statusCell];
  const table = element(null);
  table.rowData = options.rows || [{ ...row(split('DONE', 1, 1)), originalFileName: 'payload.xlsx' }];
  table.querySelectorAll = selector => selector === '*' ? cells : [];
  if (options.duplicateBatchCell) cells.push(element('feed-batch-id:row-3', '123456789012'));
  if (options.hidden) ({ table, batchCell, fileCell, name, countCell, statusCell, badge })[options.hidden].hidden = true;
  if (options.shadow) {
    table.querySelectorAll = () => [];
    table.shadowRoot = { querySelectorAll: selector => selector === '*' ? cells : [] };
  }
  const tables = options.duplicateTable ? [table, table] : [table];
  const document = {
    querySelector: selector => selector === 'kat-data-table#submission-status-table' ? table : null,
    querySelectorAll: selector => selector === 'kat-data-table#submission-status-table' ? tables : [],
  };
  const driver = {
    async getCurrentUrl() { return state.url; },
    async get(url) { state.navigations.push(url); state.url = url; },
    async executeScript(script, ...args) {
      state.scripts++;
      const fn = typeof script === 'function' ? `(${script.toString()})` : `(function(){${script}})`;
      const result = vm.runInNewContext(fn, { document,
        getComputedStyle: el => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' }),
      }, { timeout: 1000 })(...args);
      if (typeof script === 'function' && options.changeUrlAfterRead) state.url = options.changeUrlAfterRead;
      return result === undefined ? null : JSON.parse(JSON.stringify(result));
    },
    async findElements() { assert.fail('Processing must not locate file inputs or action buttons'); },
    async executeAsyncScript() { assert.fail('Processing must not invoke asynchronous business scripts'); },
    actions() { assert.fail('Processing must not click or send keys'); },
  };
  const zn = Object.create(ZiniaoWebDriver.prototype);
  zn.sessions = new Map([['mock-store', { driver }]]);
  zn.sleep = async () => t.mock.timers.tick(200000);
  zn.execExtract = async () => {
    state.gates++;
    return { result: { probeVersion: 2, liveDocument: true, traversalComplete: true,
      accessibleTraversalComplete: true, looksLikeLogin: state.gates === options.unsafeGate,
      looksBlocked: state.gates === options.blockedGate } };
  };
  return { state, zn, driver, document, table, cells, element, read: () => zn.readProductUploadProcessing('mock-store', {
    batchId: options.requestBatchId ?? '123456789012', expectedFileName: 'payload.xlsx', timeoutMs: 10000,
  }) };
}

test('processing transport reads the actual script with same-row DOM evidence and no business actions', async t => {
  const f = processingFixture(t, { shadow: true });
  const result = await f.read();
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.counts, { submitted: 1, success: 1, failed: null, warning: null });
  assert.deepEqual(f.state.navigations, [STATUS_URL]);
  assert.equal(f.state.gates, 3);
  assert.equal(f.state.scripts, 2);
});

test('processing transport refuses an old batch, duplicate rows and mismatched filenames', async t => {
  const valid = { ...row(split('DONE', 1, 1)), originalFileName: 'payload.xlsx' };
  const cases = [{ rows: [{ ...valid, feedIdentifier: { batchId: '999' } }] },
    { rows: [valid, valid] }, { rows: [{ ...valid, originalFileName: 'other.xlsx' }] },
    { rows: [{ ...valid, batchId: '999' }] }, { domBatchId: '999' },
    { domFileName: 'other.xlsx' }, { duplicateBatchCell: true }, { duplicateTable: true }];
  for (const options of cases) {
    const f = processingFixture(t, options);
    await assert.rejects(f.read(), error => error.code === 'PROCESSING_BATCH_NOT_FOUND');
    t.mock.timers.reset();
  }
});

test('processing transport excludes hidden identity and counts, and refuses visible count conflicts', async t => {
  for (const hidden of ['table', 'batchCell', 'fileCell', 'name', 'countCell']) {
    await assert.rejects(processingFixture(t, { hidden }).read(), error => error.code === 'PROCESSING_BATCH_NOT_FOUND');
    t.mock.timers.reset();
  }
  await assert.rejects(processingFixture(t, { domCounts: '0 / 1' }).read(), error => error.code === 'PROCESSING_EVIDENCE_CONFLICT');
});

test('processing transport refuses unsafe pages at all gates and discards evidence after a URL change', async t => {
  for (const unsafeGate of [1, 2, 3]) {
    const f = processingFixture(t, { unsafeGate });
    await assert.rejects(f.read(), error => error.code === 'PROCESSING_PAGE_UNSAFE');
    if (unsafeGate === 1) assert.equal(f.state.scripts, 0);
    t.mock.timers.reset();
  }
  await assert.rejects(processingFixture(t, { changeUrlAfterRead: `${STATUS_URL}?other=batch` }).read(),
    error => error.code === 'PROCESSING_PAGE_CHANGED');
  t.mock.timers.reset();
  await assert.rejects(processingFixture(t, { initialUrl: 'https://sellercentral.amazon.com/ap/signin' }).read(),
    error => error.code === 'PROCESSING_PAGE_CHANGED');
});

test('processing transport rejects hidden, absent, contradictory or ambiguous completed status badges', async t => {
  for (const options of [{ hidden: 'statusCell' }, { hidden: 'badge' }, { noBadge: true }]) {
    await assert.rejects(processingFixture(t, options).read(), error => error.code === 'PROCESSING_BATCH_NOT_FOUND');
    t.mock.timers.reset();
  }
  for (const options of [{ badgeType: 'danger' }, { badgeType: 'tag' }, { badgeLabel: '' },
    { badgeLabel: '  ' }, { multipleBadges: true }]) {
    await assert.rejects(processingFixture(t, options).read(), error => error.code === 'PROCESSING_EVIDENCE_CONFLICT');
    t.mock.timers.reset();
  }
  const partial = { ...row(split('DONE', 2, 1)), originalFileName: 'payload.xlsx' };
  await assert.rejects(processingFixture(t, { rows: [partial], domCounts: '1 / 2', badgeType: 'danger' }).read(),
    error => error.code === 'PROCESSING_EVIDENCE_CONFLICT');
});

function reportFixture(t, options = {}) {
  const f = processingFixture(t, { initialUrl: STATUS_URL, unsafeGate: options.unsafeGate });
  const origin = 'https://sellercentral.amazon.com';
  const link = `${origin}/listing/api/status/feeds/download?batchId=123456789012&merchantId=fixture-merchant&frpRegion=NA`;
  const record = f.table.rowData[0];
  record.merchantId = 'fixture-merchant';
  record.feedIdentifier.merchantId = 'fixture-merchant';
  record.splitStatuses[0].actions = [{ translationStringId: 'status:download_processing_summary', link }];
  const actionCell = f.element('actions-container:row-2');
  const button = f.element(null, '下载处理报告');
  button.disabled = false;
  actionCell.querySelectorAll = selector => selector === 'kat-button.actions-button' ? [button] : [];
  f.cells.push(actionCell);
  const payload = options.payload || Buffer.from('record,status\n1,success\n');
  const fetches = [], timeouts = [], responseState = { cancelled: false, reads: 0 };
  const headers = { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"',
    'content-length': String(payload.length), ...options.headers };
  f.driver.manage = () => ({
    getTimeouts: async () => ({ script: 30000 }),
    setTimeouts: async value => timeouts.push(value.script),
  });
  f.driver.executeAsyncScript = async (script, ...args) => {
    assert.equal(typeof script, 'function');
    return new Promise((resolve, reject) => {
      const context = {
        document: f.document, location: { origin }, URL, AbortController, Uint8Array, setTimeout, clearTimeout,
        getComputedStyle: el => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1' }),
        btoa: binary => Buffer.from(binary, 'binary').toString('base64'),
        fetch: async (url, request) => {
          fetches.push({ url, request });
          if (options.fetchError) throw new Error('synthetic response error');
          return { status: options.httpStatus ?? 200, redirected: options.redirected ?? false,
            url: options.responseUrl ?? link, headers: { get: name => headers[name] ?? null },
            body: { cancel: async () => { responseState.cancelled = true; }, getReader: () => ({
              read: async () => {
                responseState.reads++;
                if (options.streamError) throw new Error('synthetic stream error');
                return responseState.reads === 1 ? { done: false, value: new Uint8Array(payload) } : { done: true };
              },
              cancel: async () => { responseState.cancelled = true; },
            }) } };
        },
      };
      try {
        const fn = vm.runInNewContext(`(${script.toString()})`, context, { timeout: 1000 });
        fn(...args, value => {
          if (options.changeUrlAfterRead) f.state.url = options.changeUrlAfterRead;
          resolve(JSON.parse(JSON.stringify(value)));
        });
      } catch (error) { reject(error); }
    });
  };
  return { ...f, fetches, timeouts, responseState, payload, record, actionCell, button,
    async prepare() {
      await f.read();
      options.mutate?.({ ...f, record, actionCell, button });
    },
    download: (params = {}) => f.zn.readProductUploadProcessingReport('mock-store', {
      batchId: '123456789012', expectedFileName: 'payload.xlsx', timeoutMs: 10000, ...params,
    }),
  };
}

test('report transport executes the actual async script using one same-origin GET and consumes its binding', async t => {
  const f = reportFixture(t);
  await f.prepare();
  const result = await f.download();
  assert.deepEqual(result, { buffer: f.payload, extension: '.csv' });
  assert.equal(f.fetches.length, 1);
  assert.equal(f.fetches[0].request.method, 'GET');
  assert.equal(f.fetches[0].request.credentials, 'same-origin');
  assert.equal(f.fetches[0].request.redirect, 'error');
  assert.equal(f.fetches[0].request.body, undefined);
  assert.equal(new URL(f.fetches[0].url).pathname, '/listing/api/status/feeds/download');
  assert.deepEqual(f.timeouts, [15000, 30000]);
  assert.doesNotMatch(JSON.stringify(result), /merchant|https:|csrf/);
  await assert.rejects(f.download(), error => error.code === 'PROCESSING_REPORT_BINDING_INVALID');
  assert.equal(f.fetches.length, 1);
});

test('report transport refuses changed batch, merchant, file and hidden evidence before fetch', async t => {
  const cases = [
    ({ record }) => { record.feedIdentifier.batchId = '999'; },
    ({ record }) => { record.batchId = '999'; },
    ({ record }) => { record.merchantId = 'another-store'; },
    ({ record }) => { delete record.merchantId; delete record.feedIdentifier.merchantId; },
    ({ record }) => { record.feedIdentifier.merchantId = 'another-store'; },
    ({ record }) => { record.originalFileName = 'other.xlsx'; },
    ({ table, record }) => { table.rowData = [record, record]; },
    ({ table }) => { table.hidden = true; },
    ({ cells }) => { cells.find(cell => cell.getAttribute('data-cy-id') === 'feed-batch-id:row-2').hidden = true; },
    ({ cells }) => { cells.find(cell => cell.getAttribute('data-cy-id') === 'file-name-and-date:row-2').hidden = true; },
  ];
  for (const mutate of cases) {
    const f = reportFixture(t, { mutate });
    await f.prepare();
    await assert.rejects(f.download(), error => error.code === 'PROCESSING_REPORT_READ_FAILED');
    assert.equal(f.fetches.length, 0);
    t.mock.timers.reset();
  }
});

test('report transport never invokes POST, PUT, explicit GET or unverified/multiple/hidden actions', async t => {
  const cases = ['POST', 'PUT', 'GET', null].map(requestType => ({ record }) => {
    record.splitStatuses[0].actions[0].actionConfig = { requestType };
  });
  cases.push(
    ({ record }) => { record.splitStatuses[0].actions.push({ ...record.splitStatuses[0].actions[0] }); },
    ({ record }) => { record.splitStatuses[0].actions[0].translationStringId = 'status:delete_feed'; },
    ({ actionCell }) => { actionCell.hidden = true; },
    ({ button }) => { button.hidden = true; },
    ({ button }) => { button.disabled = true; },
  );
  for (const mutate of cases) {
    const f = reportFixture(t, { mutate });
    await f.prepare();
    assert.equal(await f.download(), null);
    assert.equal(f.fetches.length, 0);
    t.mock.timers.reset();
  }
});

test('report transport rejects unapproved action locations and query bindings before fetch', async t => {
  const candidates = [
    'https://example.invalid/listing/api/status/feeds/download?batchId=123456789012&merchantId=fixture-merchant',
    '/listing/api/status/feeds/delete?batchId=123456789012&merchantId=fixture-merchant',
    '/listing/api/status/feeds/download?batchId=999&merchantId=fixture-merchant',
    '/listing/api/status/feeds/download?batchId=123456789012&batchId=123456789012&merchantId=fixture-merchant',
    '/listing/api/status/feeds/download?batchId=123456789012&merchantId=other-store',
    '/listing/api/status/feeds/download?batchId=123456789012&merchantId=fixture-merchant&extra=1',
  ];
  for (const link of candidates) {
    const f = reportFixture(t, { mutate: ({ record }) => { record.splitStatuses[0].actions[0].link = link; } });
    await f.prepare();
    await assert.rejects(f.download(), error => error.code === 'PROCESSING_REPORT_READ_FAILED');
    assert.equal(f.fetches.length, 0);
    t.mock.timers.reset();
  }
});

test('report transport rejects HTML MIME, bad attachments, redirects, HTTP failures and invalid sizes', async t => {
  const cases = [
    { headers: { 'content-type': 'text/html' } },
    { headers: { 'content-disposition': 'inline; filename="report.csv"' } },
    { headers: { 'content-disposition': 'attachment; filename="report.html"' } },
    { redirected: true }, { responseUrl: 'https://example.invalid/report.csv' },
    { httpStatus: 403 }, { httpStatus: 500 }, { headers: { 'content-length': '20971521' } },
    { headers: { 'content-length': '2' } }, { headers: { 'content-length': 'not-a-number' } },
    { headers: { 'content-length': '0' } }, { headers: { 'content-length': '-1' } },
    { payload: Buffer.alloc(0) }, { streamError: true }, { fetchError: true },
  ];
  for (const options of cases) {
    const f = reportFixture(t, options);
    await f.prepare();
    await assert.rejects(f.download(), error => error.code === 'PROCESSING_REPORT_READ_FAILED');
    assert.equal(f.fetches.length, 1);
    assert.deepEqual(f.timeouts, [15000, 30000]);
    t.mock.timers.reset();
  }
  const large = reportFixture(t, { payload: Buffer.alloc(20 * 1024 * 1024 + 1), headers: { 'content-length': null } });
  await large.prepare();
  await assert.rejects(large.download(), error => error.code === 'PROCESSING_REPORT_READ_FAILED');
  assert.equal(large.responseState.cancelled, true);
});

test('report transport cannot reuse expired/failed bindings or return bytes after page identity changes', async t => {
  const missing = reportFixture(t);
  await assert.rejects(missing.download(), error => error.code === 'PROCESSING_REPORT_BINDING_INVALID');
  assert.equal(missing.fetches.length, 0);
  t.mock.timers.reset();
  const expired = reportFixture(t);
  await expired.prepare();
  t.mock.timers.tick(30001);
  await assert.rejects(expired.download(), error => error.code === 'PROCESSING_REPORT_BINDING_INVALID');
  assert.equal(expired.fetches.length, 0);
  t.mock.timers.reset();
  const changed = reportFixture(t, { changeUrlAfterRead: `${STATUS_URL}?different=batch` });
  await changed.prepare();
  await assert.rejects(changed.download(), error => error.code === 'PROCESSING_REPORT_PAGE_UNSAFE');
  assert.equal(changed.fetches.length, 1);
  await assert.rejects(changed.download(), error => error.code === 'PROCESSING_REPORT_BINDING_INVALID');
  assert.deepEqual(changed.timeouts, [15000, 30000]);
  t.mock.timers.reset();
  const mismatched = reportFixture(t);
  await mismatched.prepare();
  await assert.rejects(mismatched.download({ batchId: '999' }), error => error.code === 'PROCESSING_REPORT_BINDING_INVALID');
  await assert.rejects(mismatched.download(), error => error.code === 'PROCESSING_REPORT_BINDING_INVALID');
  assert.equal(mismatched.fetches.length, 0);
  t.mock.timers.reset();
  for (const unsafeGate of [4, 5]) {
    const unsafe = reportFixture(t, { unsafeGate });
    await unsafe.prepare();
    await assert.rejects(unsafe.download(), error => error.code === 'PROCESSING_REPORT_PAGE_UNSAFE');
    assert.equal(unsafe.fetches.length, unsafeGate === 4 ? 0 : 1);
    await assert.rejects(unsafe.download(), error => error.code === 'PROCESSING_REPORT_BINDING_INVALID');
    t.mock.timers.reset();
  }
});

test('report transport identifies Amazon macro-enabled MIME even with an encoded or suffixless attachment name', async t => {
  // This verifies transport format selection only. ZIP/VBA inspection remains
  // mandatory in the report storage layer before this buffer can be published.
  for (const disposition of ['attachment; filename="encoded-download"',
    "attachment; filename*=UTF-8''processing-report%2Exlsm"]) {
    const f = reportFixture(t, { payload: Buffer.from([80, 75, 3, 4]), headers: {
      'content-type': 'application/vnd.ms-excel.sheet.macroEnabled.12',
      'content-disposition': disposition,
    } });
    await f.prepare();
    const result = await f.download();
    assert.equal(result.extension, '.xlsm');
    assert.deepEqual(result.buffer, f.payload);
    assert.equal(f.fetches.length, 1);
    t.mock.timers.reset();
  }
});
