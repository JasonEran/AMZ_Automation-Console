#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { redactText, sanitizeForStorage } from '../src/lib/redact.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.resolve(SCRIPT_DIR, '..', 'out');
const TEXT_EXTENSIONS = new Set(['.json', '.jsonl', '.csv', '.html', '.htm', '.txt', '.log']);

function usage() {
  return [
    '历史报告脱敏（默认只审计，不写文件）',
    '',
    '  node scripts/sanitize-history.mjs [--dir <out目录>] [--apply]',
    '',
    'dry-run 只汇总待变更文件数；--apply 使用同目录原子替换并保留原 mtime。',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { apply: false, dir: DEFAULT_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dir') options.dir = path.resolve(argv[++i] || '');
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`未知参数: ${arg}`);
  }
  return options;
}

function assertSafeTarget(target) {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) throw new Error('目标目录不存在');
  const lstat = fs.lstatSync(resolved);
  if (lstat.isSymbolicLink()) throw new Error('目标目录不得是符号链接');
  if (!lstat.isDirectory()) throw new Error('目标不是目录');
  const real = fs.realpathSync(resolved);
  const filesystemRoot = path.parse(real).root;
  let home = null;
  try { home = fs.realpathSync(os.homedir()); } catch { /* unavailable */ }
  let cwd = path.resolve(process.cwd());
  try { cwd = fs.realpathSync(cwd); } catch { /* unavailable */ }
  const relativeToCwd = path.relative(real, cwd);
  const containsCwd = relativeToCwd === ''
    || (!relativeToCwd.startsWith(`..${path.sep}`) && relativeToCwd !== '..' && !path.isAbsolute(relativeToCwd));
  if (real === filesystemRoot || (home && real === home) || containsCwd) {
    throw new Error('拒绝扫描过宽目录；请明确指定本项目的 out 目录');
  }
  // Preserve the caller's absolute spelling so historical artifact paths using
  // macOS /var versus /private/var still normalize relative to the requested
  // root after the canonical safety checks above.
  return resolved;
}

function listTextFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...listTextFiles(file));
    else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(file);
  }
  return out.sort();
}

function jsonIndent(source) {
  const match = source.match(/\n([ \t]+)["}]/);
  if (!match) return 0;
  return match[1].includes('\t') ? '\t' : Math.min(8, match[1].length);
}

function sanitizeJson(source, rootDir) {
  const value = JSON.parse(source);
  const safe = sanitizeForStorage(value, { rootDir });
  return `${JSON.stringify(safe, null, jsonIndent(source))}${source.endsWith('\n') ? '\n' : ''}`;
}

function sanitizeJsonLines(source, rootDir) {
  const hadFinalNewline = source.endsWith('\n');
  const lines = source.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();
  const safe = lines.map((line) => {
    if (!line.trim()) return line;
    try {
      return JSON.stringify(sanitizeForStorage(JSON.parse(line), { rootDir }));
    } catch {
      return redactText(line);
    }
  }).join('\n');
  return hadFinalNewline ? `${safe}\n` : safe;
}

function parseCsvRow(line) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted && char === '"' && line[index + 1] === '"') { value += '"'; index++; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ',' && !quoted) { cells.push(value); value = ''; continue; }
    value += char;
  }
  cells.push(value);
  return cells;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sanitizeCsv(source, rootDir) {
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const body = bom ? source.slice(1) : source;
  const finalNewline = body.endsWith('\n');
  const lines = body.split(/\r?\n/);
  if (finalNewline) lines.pop();
  if (!lines.length) return source;
  const header = parseCsvRow(lines[0]);
  const sensitive = /^(?:store_?id|browser_?oauth|password|secret|token|authorization|otp|verification_?code)$/i;
  const urlColumn = /(?:^|_)url$/i;
  const pathColumn = /(?:screenshot|raw_text_file|report_file|file_path|path)$/i;
  const rows = [header.map(csvCell).join(',')];
  for (const line of lines.slice(1)) {
    const cells = parseCsvRow(line);
    const safe = cells.map((cell, index) => {
      const name = header[index] || '';
      if (sensitive.test(name)) return cell ? '[REDACTED]' : '';
      if (urlColumn.test(name)) return sanitizeForStorage(cell, { rootDir });
      if (pathColumn.test(name)) return sanitizeForStorage(cell, { rootDir });
      return redactText(cell);
    });
    rows.push(safe.map(csvCell).join(','));
  }
  return `${bom}${rows.join('\n')}${finalNewline ? '\n' : ''}`;
}

function sanitizeFile(source, extension, rootDir) {
  if (extension === '.json') {
    try { return sanitizeJson(source, rootDir); } catch { return redactText(source); }
  }
  if (extension === '.jsonl') return sanitizeJsonLines(source, rootDir);
  if (extension === '.csv') return sanitizeCsv(source, rootDir);
  return redactText(source);
}

function atomicReplace(file, content, stat) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx', stat.mode & 0o777);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
    fs.chmodSync(file, stat.mode & 0o777);
    fs.utimesSync(file, stat.atime, stat.mtime);
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* no temporary file remains */ }
    throw error;
  }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  options.dir = assertSafeTarget(options.dir);
} catch (error) {
  process.stderr.write(`脱敏未执行: ${redactText(error.message)}\n`);
  process.exit(2);
}

let scanned = 0;
let changed = 0;
let bytes = 0;
let failed = 0;
for (const file of listTextFiles(options.dir)) {
  scanned++;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) continue;
    const source = fs.readFileSync(file, 'utf8');
    const safe = sanitizeFile(source, path.extname(file).toLowerCase(), options.dir);
    if (safe === source) continue;
    changed++;
    bytes += Buffer.byteLength(source);
    if (options.apply) atomicReplace(file, safe, stat);
  } catch {
    // Do not print an exception that could contain source fragments or paths.
    failed++;
  }
}

const mode = options.apply ? 'apply' : 'dry-run';
process.stdout.write(
  `历史脱敏 ${mode}: 扫描 ${scanned} 个文本文件，${changed} 个需变更，`
  + `涉及 ${bytes} 字节，失败 ${failed} 个；未输出任何原始值。\n`,
);
process.exit(failed ? 2 : 0);
