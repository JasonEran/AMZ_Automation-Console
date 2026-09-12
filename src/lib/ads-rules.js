import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STORE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateAdsNameContains(value) {
  const keyword = String(value || '').trim();
  if (!keyword || keyword.length > 40 || /[\u0000-\u001f\u007f]/.test(keyword)) {
    throw new Error('广告名称特征须为 1-40 个可见字符');
  }
  return keyword;
}

export function adsRulesPath(outDir) {
  return path.join(path.resolve(outDir), 'runtime', 'ads-rules.json');
}

function privateRuntimeDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('广告规则目录类型不安全');
  try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX */ }
}

export function readAdsRules(outDir) {
  const file = adsRulesPath(outDir);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('广告规则文件类型不安全');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`广告规则文件损坏，拒绝回退到全账户范围: ${error.message}`); }
  if (parsed?.version !== 1 || !Array.isArray(parsed.rules)) {
    throw new Error('广告规则文件格式无效，拒绝回退到全账户范围');
  }
  const rules = new Map();
  for (const row of parsed.rules) {
    const storeKey = String(row?.storeKey || '');
    if (!STORE_KEY_RE.test(storeKey) || rules.has(storeKey)) {
      throw new Error('广告规则包含无效或重复店铺');
    }
    rules.set(storeKey, validateAdsNameContains(row?.nameContains));
  }
  return rules;
}

export function writeAdsRules(outDir, input) {
  const rows = input instanceof Map
    ? [...input.entries()].map(([storeKey, nameContains]) => ({ storeKey, nameContains }))
    : input;
  if (!Array.isArray(rows)) throw new Error('广告规则提交格式无效');
  const normalized = [];
  const seen = new Set();
  for (const row of rows) {
    const storeKey = String(row?.storeKey || '');
    if (!STORE_KEY_RE.test(storeKey) || seen.has(storeKey)) throw new Error('广告规则包含无效或重复店铺');
    seen.add(storeKey);
    normalized.push({ storeKey, nameContains: validateAdsNameContains(row?.nameContains) });
  }
  normalized.sort((a, b) => a.storeKey.localeCompare(b.storeKey));
  const file = adsRulesPath(outDir);
  privateRuntimeDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, rules: normalized }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
  return file;
}
