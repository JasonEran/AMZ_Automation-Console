import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isApprovedAmazonHostname } from './amazon-url.js';

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_BYTES = 1024 * 1024;
const MAX_STORES = 1000;
const EDITABLE = new Set(['name', 'displayName', 'id', 'market', 'host', 'enabled']);
export const STORE_MARKETS = Object.freeze(['US', 'CA', 'MX', 'BR', 'UK', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'SE', 'PL', 'BE', 'TR', 'JP', 'IN', 'AU', 'SG', 'AE', 'SA', 'EG']);
export const STORE_HOSTS = Object.freeze([
  'amazon.com', 'amazon.ca', 'amazon.com.mx', 'amazon.com.br', 'amazon.co.uk',
  'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es', 'amazon.nl', 'amazon.se',
  'amazon.pl', 'amazon.com.be', 'amazon.com.tr', 'amazon.co.jp', 'amazon.in',
  'amazon.com.au', 'amazon.sg', 'amazon.ae', 'amazon.sa', 'amazon.eg',
].map(suffix => `sellercentral.${suffix}`).filter(isApprovedAmazonHostname));

function failure(message, status = 400, code = 'STORE_REGISTRY_INVALID') {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function text(value, field, max, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)
      || value !== value.trim() || (required && !value)) throw failure(`${field} 格式或长度无效`);
  return value;
}
function key(value) {
  if (typeof value !== 'string' || !KEY_RE.test(value)) throw failure('店铺 key 必须为 1-64 位字母、数字、点、下划线或连字符');
  return value;
}
function validateInput(input, creating) {
  if (!plain(input) || !Object.keys(input).length) throw failure('店铺提交内容必须是非空对象');
  for (const field of Object.keys(input)) {
    if (!EDITABLE.has(field) && !(creating && field === 'key')) throw failure('店铺提交包含不可编辑字段');
  }
  const result = {};
  if (creating) {
    result.key = key(input.key);
    if (Object.hasOwn(Object.prototype, result.key) || result.key === 'prototype') throw failure('店铺 key 不能使用对象保留名称');
  }
  for (const field of ['name', 'displayName']) {
    if (Object.hasOwn(input, field)) result[field] = text(input[field], field, 160);
  }
  if (Object.hasOwn(input, 'id')) {
    result.id = text(input.id, 'id', 30);
    if (result.id && !/^[1-9][0-9]{0,29}$/.test(result.id)) throw failure('id 只能是紫鸟数字 browserId，不能填写 browserOauth 或凭据');
  }
  if (Object.hasOwn(input, 'market') || creating) {
    if (!STORE_MARKETS.includes(input.market)) throw failure('market 必须是允许的 Amazon 站点代码');
    result.market = input.market;
  }
  if (Object.hasOwn(input, 'host') || creating) {
    const host = text(input.host, 'host', 100, true);
    if (!STORE_HOSTS.includes(host)) {
      throw failure('host 必须是精确的 Seller Central 主机名，不含协议、端口或路径');
    }
    result.host = host;
  }
  if (Object.hasOwn(input, 'enabled')) {
    if (typeof input.enabled !== 'boolean') throw failure('enabled 必须为布尔值');
    result.enabled = input.enabled;
  }
  return result;
}

export function storeRegistryPath(outDir) {
  return path.join(path.resolve(outDir), 'runtime', 'store-registry.json');
}

// A registry never reads or writes the secret-bearing general configuration.
// O_NOFOLLOW and fstat protect the actual opened file as well as its path.
function readFile(file, { optional = false, managed = false } = {}) {
  let fd;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) {
      throw failure('店铺配置文件类型或大小不安全', 503, 'STORE_REGISTRY_STORAGE');
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_BYTES || opened.ino !== stat.ino || opened.dev !== stat.dev) {
      throw failure('店铺配置文件已变化或类型不安全', 503, 'STORE_REGISTRY_STORAGE');
    }
    if (managed && process.platform !== 'win32' && (opened.mode & 0o077)) {
      throw failure('管理店铺配置必须使用 0600 权限', 503, 'STORE_REGISTRY_STORAGE');
    }
    const bytes = fs.readFileSync(fd);
    if (bytes.length > MAX_BYTES) throw failure('店铺配置文件过大', 503, 'STORE_REGISTRY_STORAGE');
    return bytes;
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error.status) throw error;
    throw failure('店铺配置文件无法安全读取', 503, 'STORE_REGISTRY_STORAGE');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
function parse(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw failure('店铺配置损坏，已停止读取，未回退或覆盖', 503, 'STORE_REGISTRY_CORRUPT'); }
}
function checkedDir(dir, create = false) {
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = fs.lstatSync(dir); }
  catch (error) { if (!create && error.code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('店铺配置目录类型不安全', 503, 'STORE_REGISTRY_STORAGE');
  if (create && process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  return true;
}
function normalizeRows(rows, defaultHost, managed) {
  if (!Array.isArray(rows) || rows.length > MAX_STORES) throw failure('店铺配置格式或数量无效', 503, 'STORE_REGISTRY_CORRUPT');
  const stores = [], seen = new Set();
  rows.forEach((row, index) => {
    // Preserve the old loader's unnamed placeholder behavior at bootstrap only.
    if (!managed && (!row || (!row.name && !row.id && !(row.key && row.enabled === false)))) return;
    if (!plain(row)) throw failure('店铺记录格式无效', 503, 'STORE_REGISTRY_CORRUPT');
    if (managed && (Object.keys(row).some(field => !['key', ...EDITABLE, 'adsNameContains', 'paths'].includes(field))
        || ['key', 'name', 'displayName', 'id', 'market', 'host', 'adsNameContains'].some(field => typeof row[field] !== 'string')
        || typeof row.enabled !== 'boolean' || !Object.hasOwn(row, 'paths'))) {
      throw failure('管理店铺记录字段或类型无效，未回退', 503, 'STORE_REGISTRY_CORRUPT');
    }
    const store = {
      key: String(row.key || row.name || row.id || `store-${index + 1}`),
      name: row.name || '', displayName: row.displayName || '', id: typeof row.id === 'number' ? String(row.id) : row.id || '',
      market: row.market || '', host: row.host || defaultHost,
      enabled: row.enabled !== false,
      adsNameContains: String(row.adsNameContains || '').trim(),
      paths: row.paths == null ? null : structuredClone(row.paths),
    };
    // Existing string identifiers (including legacy opaque identifiers) are
    // carried forward. New management inputs accept only numeric browserId.
    for (const field of ['key', 'name', 'displayName', 'id', 'market', 'host']) {
      if (typeof store[field] !== 'string' || store[field].length > (field === 'id' ? 4096 : 256)
          || /[\u0000-\u001f\u007f]/.test(store[field])) {
        throw failure('店铺记录字段无效', 503, 'STORE_REGISTRY_CORRUPT');
      }
    }
    key(store.key);
    if (seen.has(store.key)) throw failure(`店铺 key 重复：${store.key}`, 503, 'STORE_REGISTRY_CORRUPT');
    seen.add(store.key);
    if (managed && store.enabled && (!store.name && !store.id)) throw failure('店铺缺少紫鸟绑定', 503, 'STORE_REGISTRY_CORRUPT');
    if (store.paths !== null && (!Array.isArray(store.paths) || store.paths.length > 30
        || store.paths.some(value => typeof value !== 'string' || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value)))) {
      throw failure('历史店铺 paths 格式无效', 503, 'STORE_REGISTRY_CORRUPT');
    }
    stores.push(store);
  });
  return stores;
}

/** Read fresh non-secret registry data, including disabled stores. No writes.
 * revision is an opaque content token, suitable for expectedRevision. A missing
 * managed file alone permits bootstrap fallback; a corrupt one fails closed.
 */
export function readStoreRegistry({ outDir, storesPath, defaultHost = 'sellercentral.amazon.com' }) {
  const file = storeRegistryPath(outDir);
  checkedDir(path.resolve(outDir));
  checkedDir(path.dirname(file));
  let bytes = readFile(file, { optional: true, managed: true }), source = 'managed', rows;
  if (bytes !== null) {
    const document = parse(bytes);
    if (!plain(document) || document.version !== 1 || !Array.isArray(document.stores)) {
      throw failure('管理店铺配置格式无效，未回退', 503, 'STORE_REGISTRY_CORRUPT');
    }
    rows = document.stores;
  } else {
    bytes = storesPath ? readFile(path.resolve(storesPath), { optional: true }) : null;
    source = bytes === null ? 'missing' : 'bootstrap';
    if (bytes === null) { bytes = Buffer.from('[]'); rows = []; }
    else {
      const document = parse(bytes);
      rows = Array.isArray(document) ? document : document?.stores;
    }
  }
  const contentSHA = crypto.createHash('sha256').update(bytes).digest('hex');
  return { revision: `${source}:${contentSHA}`, contentSHA, source,
    stores: normalizeRows(rows, defaultHost, source === 'managed') };
}

/** Binding changes require the HTTP caller's collector lease and upload guard.
 * displayName is presentation only; name remains the exact ZiNiao lookup name.
 */
export function storeBindingChanged(before, after) {
  return ['name', 'id', 'market', 'host'].some(field => String(before?.[field] || '') !== String(after?.[field] || ''));
}

/** Synchronous local registry. Caller owns authentication, CSRF, run lease and
 * pending-upload checks. This model performs no Amazon, CRM or scheduler calls.
 * create({store,expectedRevision,actor}) / update(key,{patch,expectedRevision,actor})
 * return {...read(), store}. Keys cannot be renamed; disable instead of delete.
 */
export function createStoreRegistry({ outDir, storesPath, defaultHost = 'sellercentral.amazon.com', now = Date.now }) {
  const options = { outDir, storesPath, defaultHost };
  const file = storeRegistryPath(outDir), lock = `${file}.lock`;
  const read = () => readStoreRegistry(options);
  function mutate(expectedRevision, actor, transform) {
    if (typeof expectedRevision !== 'string' || !/^(?:managed|bootstrap|missing):[a-f0-9]{64}$/.test(expectedRevision)) {
      throw failure('缺少有效的店铺配置版本，请刷新后重试', 409, 'STORE_REGISTRY_CONFLICT');
    }
    const by = text(actor, 'actor', 160, true);
    checkedDir(path.resolve(outDir), true);
    checkedDir(path.dirname(file), true);
    let lockFd;
    try { lockFd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw failure('店铺配置正在保存或保存锁待检查，请稍后重试', 409, 'STORE_REGISTRY_LOCKED');
      throw failure('无法建立店铺配置保存锁', 503, 'STORE_REGISTRY_STORAGE');
    }
    const lockStat = fs.fstatSync(lockFd);
    let tmp;
    try {
      fs.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }));
      const current = read();
      if (current.revision !== expectedRevision) throw failure('店铺配置已更新，请刷新后重试', 409, 'STORE_REGISTRY_CONFLICT');
      const changed = transform(current.stores);
      if (current.stores.length > MAX_STORES) throw failure('店铺数量达到上限');
      const document = { version: 1, updatedAt: new Date(now()).toISOString(), updatedBy: by, stores: current.stores };
      const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
      if (bytes.length > MAX_BYTES) throw failure('店铺配置超过安全大小上限');
      tmp = path.join(path.dirname(file), `.store-registry.${process.pid}.${crypto.randomUUID()}.tmp`);
      const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      tmp = null;
      const directoryFd = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      const saved = read();
      return { ...saved, store: saved.stores.find(store => store.key === changed.key) };
    } finally {
      try {
        if (tmp) { try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      } finally {
        fs.closeSync(lockFd);
        try {
          const currentLock = fs.lstatSync(lock);
          if (currentLock.ino === lockStat.ino && currentLock.dev === lockStat.dev) fs.unlinkSync(lock);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  return {
    read,
    create({ store, expectedRevision, actor } = {}) {
      const values = validateInput(store, true);
      const row = { name: '', displayName: '', id: '', enabled: false, adsNameContains: '', paths: null, ...values };
      if (!row.name && !row.id) throw failure('请填写紫鸟店铺名称或数字 browserId');
      return mutate(expectedRevision, actor, stores => {
        if (stores.some(existing => existing.key === row.key)) throw failure('店铺 key 已存在，包括停用店铺', 409, 'STORE_REGISTRY_EXISTS');
        stores.push(row);
        return row;
      });
    },
    update(storeKey, { patch, expectedRevision, actor } = {}) {
      key(storeKey);
      const values = validateInput(patch, false);
      return mutate(expectedRevision, actor, stores => {
        const index = stores.findIndex(store => store.key === storeKey);
        if (index < 0) throw failure('店铺不存在', 404, 'STORE_REGISTRY_NOT_FOUND');
        const before = stores[index];
        const row = { ...before, ...values };
        if (!row.name && !row.id && (row.enabled || before.name || before.id)) {
          throw failure('店铺必须保留紫鸟名称或数字 browserId');
        }
        stores[index] = row;
        return row;
      });
    },
  };
}
