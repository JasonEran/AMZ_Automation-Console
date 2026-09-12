#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { bjDateKey, bjIso } from '../lib/time.js';

const DAY_MS = 86_400_000;

function sameOrAncestor(candidate, target) {
  const relative = path.relative(candidate, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Refuse a typo that would turn retention into a broad filesystem cleanup. */
export function assertSafeRetentionRoot(outDir) {
  if (typeof outDir !== 'string' || !outDir.trim()) throw new Error('retention outDir 不能为空');
  const resolved = path.resolve(outDir);
  if (!fs.existsSync(resolved)) throw new Error(`retention outDir 不存在，拒绝创建或清理: ${resolved}`);
  const lstat = fs.lstatSync(resolved);
  if (lstat.isSymbolicLink()) throw new Error(`retention outDir 不得是符号链接: ${resolved}`);
  if (!lstat.isDirectory()) throw new Error(`retention outDir 不是目录: ${resolved}`);
  const real = fs.realpathSync(resolved);
  const filesystemRoot = path.parse(real).root;
  let home = null;
  try { home = fs.realpathSync(os.homedir()); } catch { /* unavailable */ }
  let cwd = path.resolve(process.cwd());
  try { cwd = fs.realpathSync(cwd); } catch { /* unavailable */ }
  if (real === filesystemRoot || (home && real === home) || sameOrAncestor(real, cwd)) {
    throw new Error(`retention outDir 范围过宽，拒绝清理: ${real}`);
  }
  // Keep the caller-visible absolute spelling (for deterministic reports),
  // after all scope checks have been performed against the canonical target.
  return resolved;
}

function walk(root, visit) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      visit(file, entry);
      walk(file, visit);
    } else if (entry.isFile()) visit(file, entry);
  }
}

export function retentionClass(relative) {
  const posix = relative.split(path.sep).join('/');
  // Baselines and the CRM idempotency ledger are durable state. Channel JSONL
  // files are audit trails and must not grow forever merely because they live
  // under channels/.
  if (posix === 'runtime/ads-monitoring.json'
      || /^state\//.test(posix)
      || /^channels\/crm\/ledger\.json$/.test(posix)
      || /(^|\/)latest\.json$/.test(posix)) return 'keep';
  if (/^product-uploads\/jobs\/[^/]+\/payload\./.test(posix)) return 'uploadPayload';
  if (/^product-uploads\/(?:jobs|audit)\//.test(posix)) return 'audit';
  if (/^(?:alerts|channels)\//.test(posix)) return 'audit';
  if (/^logs\//.test(posix)) return 'log';
  if (/(^|\/)shots\//.test(posix) || /(^|\/)raw\//.test(posix) || /^probe\//.test(posix)) return 'evidence';
  return 'report';
}

export function retentionPlan({ outDir, now = Date.now(), days = {} }) {
  outDir = assertSafeRetentionRoot(outDir);
  const limits = {
    evidence: Number(days.evidence ?? process.env.AMZGUARD_EVIDENCE_RETENTION_DAYS ?? 45),
    report: Number(days.report ?? process.env.AMZGUARD_REPORT_RETENTION_DAYS ?? 365),
    log: Number(days.log ?? process.env.AMZGUARD_LOG_RETENTION_DAYS ?? 60),
    audit: Number(days.audit ?? process.env.AMZGUARD_AUDIT_RETENTION_DAYS ?? 365),
    uploadPayload: Number(days.uploadPayload ?? process.env.AMZGUARD_UPLOAD_PAYLOAD_RETENTION_DAYS ?? 7),
  };
  const remove = [];
  let bytes = 0;
  walk(outDir, (file, entry) => {
    if (!entry.isFile()) return;
    const relative = path.relative(outDir, file);
    if (!relative || relative.startsWith(`..${path.sep}`)) return;
    const category = retentionClass(relative);
    if (category === 'keep') return;
    const stat = fs.statSync(file);
    const maxAge = Math.max(1, limits[category]) * DAY_MS;
    if (now - stat.mtimeMs > maxAge) {
      remove.push({ file, relative: relative.split(path.sep).join('/'), category, bytes: stat.size });
      bytes += stat.size;
    }
  });
  return { limits, remove, bytes };
}

export function runRetention({ outDir, apply = false, now = Date.now() }) {
  outDir = assertSafeRetentionRoot(outDir);
  const plan = retentionPlan({ outDir, now });
  let removed = 0;
  if (apply) {
    for (const item of plan.remove) {
      fs.unlinkSync(item.file);
      removed++;
    }
  }

  const record = {
    at: bjIso(new Date(now)), mode: apply ? 'apply' : 'dry-run', candidates: plan.remove.length,
    removed, bytes: plan.bytes, limits: plan.limits,
  };
  if (!apply) return { ...record, auditFile: null };

  // Permission correction is intentionally apply-only: dry-run is read-only.
  walk(outDir, (file, entry) => {
    try { fs.chmodSync(file, entry.isDirectory() ? 0o700 : 0o600); } catch { /* non-POSIX */ }
  });
  try { fs.chmodSync(outDir, 0o700); } catch { /* non-POSIX */ }

  const auditDir = path.join(outDir, 'channels', 'retention');
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const auditFile = path.join(auditDir, `${bjDateKey(new Date(now))}.jsonl`);
  fs.appendFileSync(auditFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return { ...record, auditFile };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  process.umask(0o077);
  const { config } = loadConfig();
  const result = runRetention({ outDir: config.outDir, apply: process.argv.includes('--apply') });
  console.log(`${result.mode}: ${result.removed}/${result.candidates} files, ${result.bytes} bytes eligible`);
}
