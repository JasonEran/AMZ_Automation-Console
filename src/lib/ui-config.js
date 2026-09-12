import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const UI_DEFAULTS = Object.freeze({
  reportRefreshSeconds: 30, progressRefreshSeconds: 2, uploadRefreshSeconds: 15,
  matrixPageSize: 8, listPageSize: 10, defaultView: 'overview',
});
export const UI_VIEWS = Object.freeze([
  'overview', 'store-risk', 'customer-voice', 'product-status', 'intelligence',
  'ads-watch', 'upload', 'system', 'users', 'stores',
]);
const RANGES = { reportRefreshSeconds: [5, 300], progressRefreshSeconds: [1, 30],
  uploadRefreshSeconds: [5, 120], matrixPageSize: [1, 100], listPageSize: [1, 100] };
const error = (message, status = 400, code = 'UI_CONFIG_INVALID') => Object.assign(new Error(message), { status, code });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function validate(settings, partial = false) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw error('显示配置必须是对象');
  for (const key of Object.keys(settings)) if (!Object.hasOwn(UI_DEFAULTS, key)) throw error('显示配置包含未知字段');
  const result = partial ? { ...UI_DEFAULTS, ...settings } : { ...settings };
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw error(`${key} 必须是 ${min}–${max} 之间的整数`);
  }
  if (!UI_VIEWS.includes(result.defaultView)) throw error('默认工作区无效');
  return Object.fromEntries(Object.keys(UI_DEFAULTS).map(key => [key, result[key]]));
}

/** Only display settings: this module cannot change collection, grants or writes. */
export function createUiConfig({ outDir, defaults = {}, now = Date.now }) {
  const initial = validate(defaults, true);
  const root = path.resolve(outDir), dir = path.join(root, 'runtime');
  const file = path.join(dir, 'ui-config.json'), lock = `${file}.lock`;
  function directories(create = false) {
    for (const target of [root, dir]) {
      if (create) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      let stat;
      try { stat = fs.lstatSync(target); }
      catch (cause) { if (!create && cause.code === 'ENOENT') continue; throw cause; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('显示配置目录不安全', 503, 'UI_CONFIG_STORAGE');
      if (create && process.platform !== 'win32') fs.chmodSync(target, 0o700);
    }
  }
  function read() {
    directories();
    let fd, bytes;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384 || (process.platform !== 'win32' && (stat.mode & 0o077))) {
        throw error('显示配置文件类型、大小或权限不安全', 503, 'UI_CONFIG_STORAGE');
      }
      bytes = fs.readFileSync(fd);
      if (bytes.length > 16384) throw error('显示配置过大', 503, 'UI_CONFIG_STORAGE');
    } catch (cause) {
      if (cause.code === 'ENOENT') return { source: 'bootstrap', revision: `bootstrap:${hash(JSON.stringify(initial))}`, settings: { ...initial } };
      if (cause.status) throw cause;
      throw error('显示配置无法读取，未回退或覆盖', 503, 'UI_CONFIG_STORAGE');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    try {
      const document = JSON.parse(bytes.toString('utf8'));
      if (document.version !== 1) throw new Error();
      return { source: 'managed', revision: `managed:${hash(bytes)}`, settings: validate(document.settings) };
    } catch { throw error('显示配置损坏，未回退或覆盖', 503, 'UI_CONFIG_CORRUPT'); }
  }
  function save({ expectedRevision, settings, actor }) {
    const valid = validate(settings);
    if (typeof actor !== 'string' || !actor || actor.length > 160 || /[\u0000-\u001f\u007f]/.test(actor)) throw error('配置操作者无效');
    if (typeof expectedRevision !== 'string') throw error('缺少配置版本，请重载后重试', 409, 'UI_CONFIG_CONFLICT');
    directories(true);
    let lockFd, tmp;
    try { lockFd = fs.openSync(lock, 'wx', 0o600); }
    catch (cause) {
      if (cause.code === 'EEXIST') throw error('显示配置正在保存或保存锁待检查', 409, 'UI_CONFIG_LOCKED');
      throw error('显示配置无法锁定', 503, 'UI_CONFIG_STORAGE');
    }
    const lockStat = fs.fstatSync(lockFd);
    try {
      fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }));
      if (read().revision !== expectedRevision) throw error('显示配置已更新，请重载后重试', 409, 'UI_CONFIG_CONFLICT');
      const bytes = `${JSON.stringify({ version: 1, updatedAt: new Date(now()).toISOString(), updatedBy: actor, settings: valid }, null, 2)}\n`;
      tmp = path.join(dir, `.ui-config.${process.pid}.${crypto.randomUUID()}.tmp`);
      const fd = fs.openSync(tmp, 'wx', 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file); tmp = null;
      const directoryFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      return read();
    } finally {
      try {
        if (tmp) { try { fs.unlinkSync(tmp); } catch (cause) { if (cause.code !== 'ENOENT') throw cause; } }
      } finally {
        fs.closeSync(lockFd);
        try {
          const stat = fs.lstatSync(lock);
          if (stat.ino === lockStat.ino && stat.dev === lockStat.dev) fs.unlinkSync(lock);
        } catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      }
    }
  }
  return { read, save };
}
