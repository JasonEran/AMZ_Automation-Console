import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const LOG_NAME_RE = /^webdriver\.\d{8}\.log$/;

function replaceSensitiveValues(input, credentials) {
  let output = String(input || '');
  for (const secret of Object.values(credentials || {}).filter(Boolean).map(String)) {
    output = output.split(secret).join('[REDACTED]');
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped && escaped !== secret) output = output.split(escaped).join('[REDACTED]');
  }
  output = output.replace(
    /("(?:company|username|password)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi,
    '$1"[REDACTED]"',
  );
  output = output.replace(
    /((?:company|username|password)\s*[=:]\s*)([^,;\s]+)/gi,
    '$1[REDACTED]',
  );
  return output;
}

function defaultLogDir(homeDir) {
  return path.join(homeDir, '.config', 'ziniaobrowser', 'instances', 'userdata1', 'logs', 'client');
}

export function sanitizeZiniaoWebDriverLogs({
  credentials = {},
  homeDir = os.homedir(),
  logDir = '',
  platform = process.platform,
} = {}) {
  if (platform !== 'linux') return { supported: false, files: 0, changed: 0 };
  const safeHome = path.resolve(homeDir);
  const expectedRoot = path.join(safeHome, '.config', 'ziniaobrowser', 'instances');
  const targetDir = path.resolve(logDir || defaultLogDir(safeHome));
  const relative = path.relative(expectedRoot, targetDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('紫鸟 WebDriver 日志目录不在允许的实例目录内');
  }
  if (!fs.existsSync(targetDir)) return { supported: true, files: 0, changed: 0 };
  const rootStat = fs.lstatSync(targetDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('紫鸟 WebDriver 日志目录类型不安全');
  }

  let files = 0;
  let changed = 0;
  for (const name of fs.readdirSync(targetDir)) {
    if (!LOG_NAME_RE.test(name)) continue;
    const file = path.join(targetDir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error('紫鸟 WebDriver 日志文件类型不安全');
    }
    files += 1;
    const original = fs.readFileSync(file, 'utf8');
    const sanitized = replaceSensitiveValues(original, credentials);
    if (sanitized === original) continue;
    const temporary = path.join(targetDir, `.sanitize-${process.pid}-${randomUUID()}`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, sanitized, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fs.utimesSync(file, stat.atime, stat.mtime);
    changed += 1;
  }

  const residualSensitiveValues = fs.readdirSync(targetDir)
    .filter((name) => LOG_NAME_RE.test(name))
    .some((name) => {
      const content = fs.readFileSync(path.join(targetDir, name), 'utf8');
      return Object.values(credentials || {}).filter(Boolean).map(String)
        .some((secret) => content.includes(secret));
    });
  if (residualSensitiveValues) throw new Error('紫鸟 WebDriver 日志脱敏后仍发现凭据残留');
  return { supported: true, files, changed };
}
