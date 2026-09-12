import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function adsMonitoringPath(outDir) {
  return path.join(path.resolve(outDir), 'runtime', 'ads-monitoring.json');
}

export function readAdsMonitoring(outDir) {
  const file = adsMonitoringPath(outDir);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid file');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.version !== 1 || typeof value.paused !== 'boolean'
      || !['campaigns', 'portfolios'].includes(value.source)) throw new Error('invalid state');
    return { paused: value.paused, source: value.source,
      reason: String(value.reason || '').slice(0, 300), updatedAt: value.updatedAt || null };
  } catch (error) {
    if (error.code === 'ENOENT') return { paused: false, source: 'portfolios', reason: '', updatedAt: null };
    // A damaged pause record must never accidentally restart monitoring.
    return { paused: true, source: 'portfolios', reason: '广告监测状态文件异常，已停止运行', updatedAt: null };
  }
}

export function writeAdsMonitoring(outDir, { paused, source = 'portfolios', reason = '' }) {
  if (typeof paused !== 'boolean' || !['campaigns', 'portfolios'].includes(source)) throw new Error('广告监测状态无效');
  const file = adsMonitoringPath(outDir);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('广告监测目录类型不安全');
  const value = { version: 1, paused, source, reason: String(reason).slice(0, 300), updatedAt: new Date().toISOString() };
  const tmp = path.join(dir, `.ads-monitoring.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  return value;
}
