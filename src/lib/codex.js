import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJsonLoose } from './ziniao.js';
import { redactText } from './redact.js';

/**
 * Codex is used as a *fallback judge only* — when the deterministic DOM and text
 * extractions both fail, or disagree with each other. It never touches Amazon:
 * it only reads page text that the selected Ziniao transport already pulled out.
 *
 * Note this ships (redacted) page text to Codex's cloud model. Set
 * `codex.enabled = false` (or CODEX_DISABLED=1) to keep everything local.
 */

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'confidence', 'evidence', 'reasoning'],
  properties: {
    status: {
      type: 'string',
      enum: ['HEALTHY', 'AT_RISK', 'UNHEALTHY', 'CRITICAL', 'DEACTIVATED', 'LOGIN_REQUIRED', 'BLOCKED', 'UNKNOWN'],
    },
    accountHealthRating: { type: ['integer', 'null'], minimum: 0, maximum: 1000 },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    evidence: { type: 'string', description: 'Verbatim snippet from the input that supports the status.' },
    reasoning: { type: 'string' },
  },
};

/** Strip the obvious personal/commercial identifiers before sending text out. */
export function redactPageText(text) {
  return redactText(String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/\b\d{3}-\d{7}-\d{7}\b/g, '[order-id]')
    .replace(/\b[A-Z0-9]{10}\b(?=\s|$|[.,;)])/g, (m) => (/^\d+$/.test(m) ? m : '[asin-or-id]'))
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[phone]'));
}

function runCodex(bin, args, { timeoutMs, cwd }) {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', cwd },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: stdout || '',
          stderr: stderr || '',
          timedOut: !!(err && err.killed),
          notFound: !!(err && err.code === 'ENOENT'),
        });
      },
    );
  });
}

/**
 * Ask Codex to classify Policy Compliance from page text.
 * Returns null when Codex is disabled or unavailable — never throws.
 */
export async function codexClassifyPolicyCompliance({
  config,
  logger,
  pageText,
  cardText,
  domStatus,
  textStatus,
  storeKey,
}) {
  const c = config.codex || {};
  if (!c.enabled) return null;

  // Authentication pages are never sent to another process or cloud model;
  // they may contain a Ziniao-filled OTP even when the collector did not read it.
  if (/\/ap\/(?:signin|cvf)|two[ -]?step|verification\s*code|验证码|一次性密码|\botp\b/i.test(`${pageText || ''} ${cardText || ''}`)) {
    return { ok: false, reason: 'authentication-page-not-exported', durationMs: 0 };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-codex-'));
  const schemaFile = path.join(tmp, 'schema.json');
  const outFile = path.join(tmp, 'answer.json');
  fs.writeFileSync(schemaFile, JSON.stringify(SCHEMA, null, 2), { mode: 0o600 });

  const maxChars = c.maxPageTextChars || 8000;
  let body = [cardText ? `--- POLICY COMPLIANCE CARD TEXT ---\n${cardText}` : '', `--- PAGE TEXT ---\n${pageText || ''}`]
    .filter(Boolean)
    .join('\n\n');
  if (c.redact !== false) body = redactPageText(body);
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}\n[truncated]`;

  const prompt = [
    'You are classifying one field on an Amazon Seller Central "Account Health" page.',
    '',
    'TASK: from the supplied text only, report the status shown on the "Policy Compliance" card',
    'and, if present, the numeric "Account Health Rating".',
    '',
    'RULES:',
    '- Use ONLY the text below. Do not open a browser, run commands, or read any file.',
    '- "Healthy" -> HEALTHY. "At Risk" -> AT_RISK. "Unhealthy" -> UNHEALTHY. "Critical" -> CRITICAL.',
    '- If the text is an Amazon sign-in page -> LOGIN_REQUIRED.',
    '- If it is a captcha / robot check / server error page -> BLOCKED.',
    '- If the Policy Compliance status genuinely cannot be determined -> UNKNOWN. Do NOT guess HEALTHY.',
    '- `evidence` must be copied verbatim from the input.',
    '- Reply with JSON matching the provided schema and nothing else.',
    '',
    `CONTEXT: deterministic parsers reported DOM=${domStatus || 'UNKNOWN'}, TEXT=${textStatus || 'UNKNOWN'} for store ${storeKey || '?'}.`,
    '',
    body,
  ].join('\n');

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color', 'never',
    '-s', c.sandbox || 'read-only',
    '--output-schema', schemaFile,
    '-o', outFile,
  ];
  if (c.model) args.push('-m', c.model);
  args.push(prompt);

  const started = Date.now();
  const res = await runCodex(c.bin || 'codex', args, { timeoutMs: c.timeoutMs || 120000, cwd: tmp });
  const durationMs = Date.now() - started;

  const cleanup = () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch { /* best effort */ }
  };

  if (res.notFound) {
    logger?.warn?.(`Codex 兜底不可用：找不到 ${c.bin || 'codex'}`);
    cleanup();
    return { ok: false, reason: 'codex-not-found', durationMs };
  }
  if (res.timedOut) {
    logger?.warn?.(`Codex 兜底超时 (${c.timeoutMs || 120000}ms)`);
    cleanup();
    return { ok: false, reason: 'timeout', durationMs };
  }

  let parsed = null;
  if (fs.existsSync(outFile)) parsed = parseJsonLoose(fs.readFileSync(outFile, 'utf8'));
  if (!parsed) parsed = parseJsonLoose(res.stdout);
  cleanup();

  if (!parsed || !parsed.status) {
    logger?.warn?.(`Codex 兜底未返回可解析结果 (exit=${res.code})`);
    return {
      ok: false,
      reason: 'unparseable',
      exitCode: res.code,
      stderr: String(res.stderr).slice(0, 800),
      durationMs,
    };
  }

  return {
    ok: true,
    status: parsed.status,
    score: Number.isFinite(parsed.accountHealthRating) ? parsed.accountHealthRating : null,
    confidence: parsed.confidence || 'low',
    evidence: parsed.evidence || null,
    reasoning: parsed.reasoning || null,
    durationMs,
    redacted: c.redact !== false,
  };
}
