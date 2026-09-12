import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assertApprovedAmazonUrl } from './amazon-url.js';
import {
  SECURITY_CLEANUP_FAILED, secureCleanupEvidence, validateEvidenceArtifact,
} from './evidence-cleanup.js';
import { redactText, sanitizeUrl } from './redact.js';

export const RESULT_MARKER = 'ZN_RESULT_V1:';

export class ZiniaoError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ZiniaoError';
    Object.assign(this, extra);
  }
}

/** True when the failure is "ziniao-cli config init has not been run". */
export function isConfigMissingError(err) {
  return /config not found|config init|WebDriver 凭据未配置|ZINIAO_(COMPANY|USERNAME|PASSWORD)/i.test(
    String(err?.message || err || ''),
  );
}

// ---------------------------------------------------------------- json helpers

export function parseJsonLoose(s) {
  if (!s || typeof s !== 'string') return null;
  const t = s.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch { /* fall through */ }
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(t.slice(i, j + 1));
    } catch { /* fall through */ }
  }
  const a = t.indexOf('[');
  const b = t.lastIndexOf(']');
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch { /* fall through */ }
  }
  return null;
}

/** Collect every value stored under `key`, at any depth. */
export function deepCollect(obj, key, maxDepth = 10) {
  const found = [];
  const seen = new Set();
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > maxDepth || seen.has(o)) return;
    seen.add(o);
    if (!Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, key)) found.push(o[key]);
    for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v, d + 1);
  };
  walk(obj, 0);
  return found;
}

/** First scalar value found for the first key that matches — key order is priority order. */
export function pickScalar(obj, keys) {
  for (const k of keys) {
    for (const v of deepCollect(obj, k)) {
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
  }
  return null;
}

/** Longest string found across the given keys — for page text/html payloads. */
export function pickLongestString(obj, keys) {
  if (typeof obj === 'string') return obj;
  let best = '';
  for (const k of keys) {
    for (const v of deepCollect(obj, k)) {
      if (typeof v === 'string' && v.length > best.length) best = v;
    }
  }
  return best || null;
}

/** Unwrap the `{ok, data, meta}` envelope the bridge returns. */
export function unwrap(json) {
  if (json && typeof json === 'object' && !Array.isArray(json) && 'ok' in json) {
    if (json.ok === false) {
      const msg =
        pickScalar(json, ['message', 'msg', 'error', 'reason', 'detail']) || 'bridge returned ok=false';
      throw new ZiniaoError(`ziniao bridge: ${msg}`, { payload: json });
    }
    return json.data !== undefined ? json.data : json;
  }
  return json;
}

// ------------------------------------------------------- exec-result extraction

/** Pull our marker payload out of a parsed JSON envelope (handles JSON-escaping). */
function findMarkerInJson(json) {
  const hits = [];
  const seen = new Set();
  const walk = (o, d) => {
    if (d > 12 || o == null) return;
    if (typeof o === 'string') {
      const i = o.indexOf(RESULT_MARKER);
      if (i >= 0) hits.push(o.slice(i + RESULT_MARKER.length));
      return;
    }
    if (typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    for (const v of Array.isArray(o) ? o : Object.values(o)) walk(v, d + 1);
  };
  walk(json, 0);
  for (const h of hits) {
    const parsed = parseJsonLoose(h);
    if (parsed) return parsed;
  }
  return null;
}

/** Last-resort: scrape the marker straight out of raw stdout. */
function findMarkerInRaw(stdout) {
  const i = stdout.indexOf(RESULT_MARKER);
  if (i < 0) return null;
  const tail = stdout.slice(i + RESULT_MARKER.length);
  const end = tail.lastIndexOf('}');
  if (end < 0) return null;
  const cand = tail.slice(0, end + 1);
  const direct = parseJsonLoose(cand);
  if (direct) return direct;
  // stdout may contain the payload still JSON-escaped
  const unescaped = cand.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
  return parseJsonLoose(unescaped);
}

function assertAscii(js) {
  const bad = /[^\x00-\x7F]/.exec(js);
  if (bad) {
    throw new ZiniaoError(
      `injected script must be ASCII-only (found ${JSON.stringify(bad[0])} at index ${bad.index})`,
    );
  }
}

/**
 * Wrap an extractor body so the result comes back three independent ways:
 * as the expression value, on `window.<varName>`, and marker-prefixed in stdout.
 */
export function buildExtractorScript(body, varName = '__ZN_R__') {
  assertAscii(body);
  return (
    `(function(){var __m=${JSON.stringify(RESULT_MARKER)};var __p;` +
    `try{__p=__m+JSON.stringify((function(){${body}\n})());}` +
    `catch(e){__p=__m+JSON.stringify({error:String((e&&e.stack)||e),phase:"extractor"});}` +
    `try{window.${varName}=__p;}catch(e2){}` +
    `return __p;})()`
  );
}

// -------------------------------------------------------------------- the class

export class Ziniao {
  constructor({ bin = 'ziniao-cli', logger = console, defaultTimeoutMs = 120000, dryRun = false } = {}) {
    this.bin = bin;
    this.logger = logger;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.dryRun = dryRun;
  }

  /** Run ziniao-cli. No shell is involved, so arguments need no quoting. */
  async cli(args, { timeoutMs = this.defaultTimeoutMs, expectJson = true } = {}) {
    const sensitiveFlags = new Set([
      '--id', '--store-id', '--browser-id', '--browser-oauth', '--container-id', '--profile-id', '--site-id', '--script',
    ]);
    const safeArgs = args.map((arg, index) => {
      const previous = String(args[index - 1] || '').toLowerCase();
      const current = String(arg || '');
      if (sensitiveFlags.has(previous)) return '[REDACTED]';
      if (/^--(?:id|store-id|browser-id|browser-oauth|container-id|profile-id|site-id)=/i.test(current)) {
        return `${current.slice(0, current.indexOf('=') + 1)}[REDACTED]`;
      }
      if (previous === '--url') return sanitizeUrl(current);
      return current;
    });
    const pretty = `${this.bin} ${safeArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
    this.logger.debug?.(`$ ${truncate(redactText(pretty), 600)}`);
    if (this.dryRun) return { code: 0, stdout: '', stderr: '', json: null, data: null, dryRun: true };

    const res = await new Promise((resolve) => {
      execFile(
        this.bin,
        args,
        { timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          resolve({
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            stdout: stdout || '',
            stderr: stderr || '',
            timedOut: !!(err && err.killed),
            spawnError: err && err.code === 'ENOENT' ? err : null,
          });
        },
      );
    });

    if (res.spawnError) {
      throw new ZiniaoError(`找不到可执行文件 ${this.bin}（请确认紫鸟 CLI 已安装并在 PATH 中）`, {
        command: pretty,
      });
    }
    if (res.timedOut) {
      throw new ZiniaoError(`命令超时 (${timeoutMs}ms): ${truncate(pretty, 200)}`, {
        command: pretty,
        stdout: res.stdout,
        stderr: res.stderr,
      });
    }

    const json = parseJsonLoose(res.stdout) ?? parseJsonLoose(res.stderr);

    if (res.code !== 0) {
      const msg =
        (json && pickScalar(json, ['message', 'msg', 'error', 'reason'])) ||
        firstLine(res.stderr) ||
        firstLine(res.stdout) ||
        `exit ${res.code}`;
      throw new ZiniaoError(msg, {
        command: pretty,
        exitCode: res.code,
        stdout: truncate(res.stdout, 4000),
        stderr: truncate(res.stderr, 4000),
      });
    }

    let data = null;
    if (expectJson) {
      try {
        data = unwrap(json);
      } catch (e) {
        e.command = pretty;
        throw e;
      }
    }
    return { code: 0, stdout: res.stdout, stderr: res.stderr, json, data };
  }

  // -- diagnostics ----------------------------------------------------------

  async version() {
    const r = await this.cli(['--version'], { timeoutMs: 20000, expectJson: false });
    return r.stdout.trim();
  }

  async doctor() {
    // `doctor` is the odd one out: it prints its human-readable report to
    // stderr and still exits 0 even when checks fail. So read both streams and
    // never let it throw — the caller decides what a failed check means.
    const merge = (a, b) => [a, b].map((s) => String(s || '').trim()).filter(Boolean).join('\n');
    try {
      const r = await this.cli(['doctor'], { timeoutMs: 90000, expectJson: false });
      const text = merge(r.stdout, r.stderr);
      return { ok: !/[✗x]|not found|failed/i.test(text), text };
    } catch (e) {
      return { ok: false, text: merge(merge(e.stdout, e.stderr), e.message) };
    }
  }

  async bridgeTools() {
    const r = await this.cli(['zclaw', 'tools'], { timeoutMs: 30000 });
    return r.data;
  }

  // -- store lifecycle ------------------------------------------------------

  async storeList({ all = true } = {}) {
    const args = ['store', 'list', '--format', 'json'];
    if (all) args.push('--all');
    const r = await this.cli(args, { timeoutMs: 60000 });
    return normalizeStoreList(r.data);
  }

  async storeResolve({ name, id }) {
    const args = ['store', 'resolve', '--format', 'json'];
    if (id) args.push('--id', String(id));
    else if (name) args.push('--name', String(name));
    else throw new ZiniaoError('storeResolve 需要 name 或 id');
    const r = await this.cli(args, { timeoutMs: 60000 });
    return { raw: r.data, storeId: pickStoreId(r.data), storeName: pickStoreName(r.data) };
  }

  async storeOpen({ name, id, url: openUrl, headless = false, privacy = false, timeoutMs } = {}) {
    const args = ['store', 'open'];
    if (id) args.push('--id', String(id));
    else if (name) args.push('--name', String(name));
    else throw new ZiniaoError('storeOpen 需要 name 或 id');
    if (openUrl) args.push('--url', assertApprovedAmazonUrl(openUrl));
    if (headless) args.push('--headless');
    if (privacy) args.push('--privacy');
    const r = await this.cli(args, { timeoutMs: timeoutMs ?? 180000 });
    const storeId = pickStoreId(r.data) || (id ? String(id) : null);
    if (!storeId) {
      throw new ZiniaoError('store open 成功但响应里找不到 storeId', {
        stdout: truncate(r.stdout, 2000),
      });
    }
    return {
      storeId,
      storeName: pickStoreName(r.data) || name || null,
      kernelDownloading: /true/i.test(String(pickScalar(r.data, ['kernelDownloading']) ?? '')),
      downloadFolderPath: pickScalar(r.data, ['downloadFolderPath']),
      raw: r.data,
    };
  }

  async storeClose(storeId) {
    const r = await this.cli(['store', 'close', '--id', String(storeId)], { timeoutMs: 60000 });
    return r.data;
  }

  // -- page operations ------------------------------------------------------

  async visit(storeId, targetUrl, { timeoutMs = 60000, waitUntil = 'networkidle', targetId } = {}) {
    targetUrl = assertApprovedAmazonUrl(targetUrl);
    const args = ['page', 'visit', '--store-id', String(storeId), '--url', targetUrl];
    if (waitUntil) args.push('--wait-until', waitUntil);
    args.push('--timeout', String(timeoutMs));
    if (targetId) args.push('--target-id', String(targetId));
    // The CLI's own timeout must outlive the in-page navigation timeout.
    const r = await this.cli(args, { timeoutMs: timeoutMs + 30000 });
    return r.data;
  }

  async currentUrl(storeId, { timeoutMs = 20000, targetId } = {}) {
    const r = await this.execExtract(
      storeId,
      'return {currentUrl:String((window.location&&window.location.href)||"")};',
      { timeoutMs, targetId, varName: '__ZN_CURRENT_URL__' },
    );
    return String(r?.result?.currentUrl || '');
  }

  async content(storeId, { format = 'text', timeoutMs = 45000, targetId } = {}) {
    const args = [
      'page', 'content',
      '--store-id', String(storeId),
      '--content-format', format,
      '--timeout', String(timeoutMs),
    ];
    if (targetId) args.push('--target-id', String(targetId));
    const r = await this.cli(args, { timeoutMs: timeoutMs + 30000 });
    const text = pickLongestString(r.data, [
      'text', 'content', 'pageText', 'innerText', 'body', 'markdown', 'html', 'result', 'value',
    ]);
    return { text: text || '', raw: r.data };
  }

  async waitElement(storeId, selector, { timeoutMs = 20000, targetId } = {}) {
    const args = [
      'page', 'wait-element',
      '--store-id', String(storeId),
      '--selector', selector,
      '--timeout', String(timeoutMs),
    ];
    if (targetId) args.push('--target-id', String(targetId));
    const r = await this.cli(args, { timeoutMs: timeoutMs + 20000 });
    return r.data;
  }

  async screenshot(storeId, filePath, { fullPage = true, timeoutMs = 60000, targetId } = {}) {
    const controlledRoot = path.dirname(path.resolve(filePath));
    const controlledTarget = path.resolve(filePath);
    fs.mkdirSync(controlledRoot, { recursive: true, mode: 0o700 });
    const staleCleanup = secureCleanupEvidence({ file: controlledTarget, outDir: controlledRoot });
    if (!staleCleanup.ok) {
      throw new ZiniaoError('旧版截图目标无法安全初始化', {
        code: SECURITY_CLEANUP_FAILED,
        cleanupReason: staleCleanup.reason,
      });
    }
    const args = [
      'page', 'screenshot',
      '--store-id', String(storeId),
      '--path', controlledTarget,
      '--timeout', String(timeoutMs),
    ];
    if (fullPage) args.push('--full-page');
    if (targetId) args.push('--target-id', String(targetId));
    const r = await this.cli(args, { timeoutMs: timeoutMs + 30000 });

    // Legacy bridge builds may ignore --path and return an arbitrary temporary
    // path. Never copy or accept that response as evidence. Only the exact
    // controlled target written by the bridge is eligible for retention.
    if (validateEvidenceArtifact({ file: controlledTarget, outDir: controlledRoot }).ok) {
      return { path: controlledTarget, raw: r.data };
    }
    const produced = pickScalar(r.data, ['filePath', 'file', 'path', 'savePath']);
    if (produced && path.resolve(String(produced)) !== controlledTarget) {
      const tempCleanup = secureCleanupEvidence({ file: String(produced), outDir: controlledRoot });
      if (!tempCleanup.ok) {
        throw new ZiniaoError('旧版桥接返回了无法安全清理的截图临时证据', {
          code: SECURITY_CLEANUP_FAILED,
          cleanupReason: tempCleanup.reason,
        });
      }
      return {
        path: null,
        raw: r.data,
        temporaryArtifactRejected: true,
        temporaryArtifactCleaned: tempCleanup.removed === true,
      };
    }
    const targetCleanup = secureCleanupEvidence({ file: controlledTarget, outDir: controlledRoot });
    if (!targetCleanup.ok) {
      throw new ZiniaoError('旧版截图目标安全验证失败且无法安全清理', {
        code: SECURITY_CLEANUP_FAILED,
        cleanupReason: targetCleanup.reason,
      });
    }
    return { path: null, raw: r.data, temporaryArtifactRejected: true };
  }

  async execScript(storeId, script, { timeoutMs = 45000, targetId } = {}) {
    const args = [
      'page', 'exec',
      '--store-id', String(storeId),
      '--script', script,
      '--timeout', String(timeoutMs),
    ];
    if (targetId) args.push('--target-id', String(targetId));
    return this.cli(args, { timeoutMs: timeoutMs + 30000 });
  }

  /**
   * Run an extractor body and get its returned object back.
   *
   * The bridge's exec contract (does it return the expression value? does it
   * echo console output?) is not documented, so this tries three paths in order:
   * marker in the parsed envelope, marker in raw stdout, then a second exec that
   * reads `window.<varName>` back.
   */
  async execExtract(storeId, body, { timeoutMs = 45000, targetId, varName = '__ZN_R__' } = {}) {
    const script = buildExtractorScript(body, varName);
    const first = await this.execScript(storeId, script, { timeoutMs, targetId });

    let hit = findMarkerInJson(first.json) || findMarkerInRaw(first.stdout);
    let via = hit ? 'exec-return' : null;

    if (!hit) {
      const probe = await this.execScript(storeId, `window.${varName} || null`, {
        timeoutMs: Math.min(timeoutMs, 20000),
        targetId,
      });
      hit = findMarkerInJson(probe.json) || findMarkerInRaw(probe.stdout);
      via = hit ? 'window-probe' : null;
    }

    if (!hit) {
      throw new ZiniaoError('page exec 未能取回提取结果（marker 缺失）', {
        stdout: truncate(first.stdout, 2000),
        stderr: truncate(first.stderr, 1000),
      });
    }
    if (hit.error && hit.phase === 'extractor') {
      throw new ZiniaoError(`页面内提取脚本抛错: ${truncate(hit.error, 500)}`, { inPage: true });
    }
    return { result: hit, via };
  }
}

// ------------------------------------------------------------------- utilities

export function pickStoreId(data) {
  return pickScalar(data, ['storeId', 'store_id', 'storeID', 'shopId', 'shop_id', 'id']);
}

export function pickStoreName(data) {
  return pickScalar(data, ['storeName', 'store_name', 'name', 'shopName', 'shop_name']);
}

/** store list responses vary in shape; flatten to {id, name, platform, raw}. */
export function normalizeStoreList(data) {
  let arr = null;
  if (Array.isArray(data)) arr = data;
  else {
    for (const k of ['list', 'items', 'stores', 'records', 'rows', 'data']) {
      const hits = deepCollect(data, k).filter(Array.isArray);
      if (hits.length) {
        arr = hits.sort((a, b) => b.length - a.length)[0];
        break;
      }
    }
  }
  if (!arr) return [];
  return arr
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      id: pickStoreId(x),
      name: pickStoreName(x),
      platform: pickScalar(x, ['platform', 'platformName', 'site']),
      raw: x,
    }))
    .filter((x) => x.id || x.name);
}

function firstLine(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t.split('\n').find((l) => l.trim()) || '';
}

export function truncate(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…[+${t.length - n}]` : t;
}
