import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The only unit this action may restart. Callers cannot substitute another name. */
export const ZINIAO_SERVICE = 'amzguard-ziniao.service';

/** Oneshot units that open a store browser or otherwise occupy Ziniao.
 * Timers and the always-on dashboard, Xvfb, and Nginx units are not included. */
export const COLLECTION_UNITS = Object.freeze([
  'amzguard-store-health-am.service',
  'amzguard-store-health-pm.service',
  'amzguard-store-health-ads-off.service',
  'amzguard-store-health-ads-on.service',
  'amzguard-collector-health.service',
  'amzguard-intelligence.service',
  'amzguard-product-upload.service',
]);

const MANUAL_UNIT = /^amzguard-manual@[A-Za-z0-9][A-Za-z0-9._:-]{0,120}\.service$/;
const STATUS_TIMEOUT_MS = 15_000;
const RESTART_TIMEOUT_MS = 120_000;
const SYSTEMCTL_ENV = {
  PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
};

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function safeText(value) {
  return String(value || 'unknown').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) || 'unknown';
}

/** A collector holds the lease when the lock names a live PID, or when the
 * file cannot be proven stale. A dead PID does not block recovery. */
export function collectorLockReason(outDir) {
  const file = path.join(outDir, 'runtime', 'run.lock');
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    return '运行锁无法读取，已拒绝重启紫鸟。';
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 65_536) {
    return '运行锁类型或大小异常，已拒绝重启紫鸟。';
  }
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return '运行锁已损坏，无法确认采集是否仍在进行，已拒绝重启紫鸟。'; }
  const pid = Number(record?.pid);
  if (!processAlive(pid)) return null;
  return `采集进程仍持有运行锁（pid=${pid}，任务=${safeText(record?.label)}），已拒绝重启紫鸟。`;
}

function detail(error, stdout, stderr) {
  return [stderr, stdout].map(part => String(part || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean).join(' ').slice(0, 400);
}

function runSystemctl(args, { execFileImpl, timeout }) {
  return new Promise((resolve, reject) => {
    execFileImpl('systemctl', args, {
      timeout, windowsHide: true, maxBuffer: 256 * 1024, encoding: 'utf8', env: SYSTEMCTL_ENV,
    }, (error, stdout, stderr) => {
      if (!error) { resolve(String(stdout || '')); return; }
      const message = error.code === 'ENOENT'
        ? '找不到 systemctl，无法操作紫鸟服务。'
        : (detail(error, stdout, stderr) || 'systemctl 执行失败');
      reject(fail(error.killed ? 504 : 503, error.killed ? 'ZINIAO_RESTART_TIMEOUT' : 'ZINIAO_RESTART_FAILED', message));
    });
  });
}

function parseStates(stdout) {
  const states = new Map();
  let current = {};
  const flush = () => {
    if (current.id) states.set(current.id, current.activeState || '');
    current = {};
  };
  for (const line of String(stdout).split('\n')) {
    if (!line.trim()) { flush(); continue; }
    if (line.startsWith('Id=')) {
      if (current.id) flush();
      current.id = line.slice(3).trim();
    } else if (line.startsWith('ActiveState=')) current.activeState = line.slice('ActiveState='.length).trim();
  }
  flush();
  return states;
}

function manualUnits(stdout) {
  const units = [];
  for (const line of String(stdout).split('\n')) {
    const name = line.trim().split(/\s+/)[0];
    if (!name) continue;
    if (!MANUAL_UNIT.test(name)) throw fail(503, 'ZINIAO_RESTART_STATUS_UNKNOWN', '无法识别采集单元名称，已拒绝重启紫鸟。');
    units.push(name);
  }
  return units;
}

async function activeCollectionUnits(execFileImpl) {
  let listed;
  try {
    listed = await runSystemctl([
      'list-units', '--type=service', '--all', '--no-legend', '--plain', '--no-pager', 'amzguard-manual@*.service',
    ], { execFileImpl, timeout: STATUS_TIMEOUT_MS });
  } catch (error) {
    throw fail(503, 'ZINIAO_RESTART_STATUS_UNKNOWN', `无法确认采集单元是否仍在运行，已拒绝重启紫鸟。${error.message}`);
  }
  const units = [...COLLECTION_UNITS, ...manualUnits(listed)];
  let shown;
  try {
    shown = await runSystemctl(['show', '--no-pager', ...units, '-p', 'Id', '-p', 'ActiveState'], {
      execFileImpl, timeout: STATUS_TIMEOUT_MS,
    });
  } catch (error) {
    throw fail(503, 'ZINIAO_RESTART_STATUS_UNKNOWN', `无法确认采集单元是否仍在运行，已拒绝重启紫鸟。${error.message}`);
  }
  const states = parseStates(shown);
  const missing = units.filter(unit => !states.has(unit));
  if (missing.length) throw fail(503, 'ZINIAO_RESTART_STATUS_UNKNOWN', '无法确认采集单元状态，已拒绝重启紫鸟。');
  return units.filter(unit => states.get(unit) === 'active' || states.get(unit) === 'activating');
}

let restarting = false;

export async function restartZiniaoService({ outDir, execFileImpl = execFile } = {}) {
  if (restarting) throw fail(409, 'ZINIAO_RESTART_IN_PROGRESS', '紫鸟重启已在进行，请等待本次结果，不要重复点击。');
  restarting = true;
  try {
    const locked = collectorLockReason(outDir);
    if (locked) throw fail(409, 'ZINIAO_RESTART_LOCKED', locked);
    const active = await activeCollectionUnits(execFileImpl);
    if (active.length) {
      throw fail(409, 'ZINIAO_RESTART_COLLECTION_ACTIVE', `采集单元仍在运行，已拒绝重启紫鸟：${active.join('、')}`);
    }
    try {
      await runSystemctl(['--no-ask-password', 'restart', ZINIAO_SERVICE], { execFileImpl, timeout: RESTART_TIMEOUT_MS });
    } catch (error) {
      const missing = /not found|not loaded|could not be found/i.test(error.message);
      throw fail(error.status || 503, missing ? 'ZINIAO_RESTART_UNIT_MISSING' : (error.code || 'ZINIAO_RESTART_FAILED'),
        missing ? `本机没有 ${ZINIAO_SERVICE}，重启未执行。${error.message}` : `重启紫鸟失败，未视为成功。${error.message}`);
    }
    return { ok: true, unit: ZINIAO_SERVICE, message: '已重启紫鸟。已打开的店铺浏览器已关闭。' };
  } finally {
    restarting = false;
  }
}
