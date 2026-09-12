#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, ROOT } from './lib/config.js';
import { TZ } from './lib/time.js';
import {
  beijingToLocal, cronLines, macPlist, macServerPlist, pad, serviceUnit, timerUnit,
  winCheckTask, winServerTask,
} from './lib/schedule-units.js';

/**
 * Scheduling for the daily patrol — launchd on macOS, systemd user timers on
 * Linux, with a printed cron fallback when neither is available.
 *
 * The requirement is stated in Beijing time, but both schedulers interpret their
 * calendar spec in the machine's *local* time. So the Beijing wall-clock time is
 * converted here rather than assumed. On a box already set to Asia/Shanghai the
 * conversion is a no-op; elsewhere it matters, and a local DST shift means the
 * units must be regenerated.
 */

const LABEL_PREFIX = 'com.singal.amzguard';
const UNIT_PREFIX = 'amzguard';
const CHECK = 'store-health';

function localTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'unknown';
  }
}

function slotsFrom(config) {
  const slots = config.schedule?.slots || [];
  if (!slots.length) throw new Error('config.schedule.slots 为空，无法安装排程');
  return slots;
}

function jobArgs(slot, { headless }) {
  const a = ['run-slot', slot.name];
  if (headless) a.push('--headless');
  return a;
}

function run(bin, args) {
  try {
    return { ok: true, out: execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status };
  }
}

function banner(config) {
  const tz = localTz();
  console.log(`平台: ${process.platform}  |  本机时区: ${tz}${tz === TZ ? ' （与北京时间一致，无需换算）' : ' （将把北京时间换算为本机时间）'}`);
  console.log(`排程时段（北京时间）: ${slotsFrom(config).map((s) => `${s.name}=${s.at}`).join(', ')}`);
  console.log('');
  return tz;
}

// ============================================================ macOS / launchd

function macDir() {
  const d = path.join(os.homedir(), 'Library', 'LaunchAgents');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function macInstall(config, opts) {
  const dir = macDir();
  const uid = process.getuid();
  let allOk = true;
  for (const slot of slotsFrom(config)) {
    const local = beijingToLocal(slot.at);
    const label = `${LABEL_PREFIX}.${CHECK}.${slot.name}`;
    const file = path.join(dir, `${label}.plist`);
    fs.writeFileSync(file, macPlist({
      label, nodeBin: process.execPath, cliPath: path.join(ROOT, 'src', 'cli.js'),
      cwd: ROOT, args: jobArgs(slot, opts), hour: local.hour, minute: local.minute,
    }));
    run('launchctl', ['bootout', `gui/${uid}/${label}`]); // harmless if absent
    let res = run('launchctl', ['bootstrap', `gui/${uid}`, file]);
    if (!res.ok) res = run('launchctl', ['load', '-w', file]); // older macOS
    console.log(res.ok
      ? `✓ ${label}\n    北京 ${slot.at} → 本机 ${pad(local.hour)}:${pad(local.minute)}\n    ${file}`
      : `✗ ${label} 加载失败: ${res.out.trim() || `exit ${res.code}`}\n    plist 已写入 ${file}`);
    if (!res.ok) allOk = false;
  }
  if (!opts.noServer) {
    const label = `${LABEL_PREFIX}.dashboard`;
    const file = path.join(dir, `${label}.plist`);
    const port = opts.port || 4173;
    fs.mkdirSync(path.join(config.outDir, 'logs'), { recursive: true });
    fs.writeFileSync(file, macServerPlist({
      label,
      nodeBin: process.execPath,
      serverPath: path.join(ROOT, 'src', 'server.js'),
      cwd: ROOT,
      port,
      logDir: path.join(config.outDir, 'logs'),
    }));
    run('launchctl', ['bootout', `gui/${uid}/${label}`]);
    let res = run('launchctl', ['bootstrap', `gui/${uid}`, file]);
    if (!res.ok) res = run('launchctl', ['load', '-w', file]);
    console.log(res.ok
      ? `✓ ${label}\n    本地看板常驻: http://127.0.0.1:${port}\n    ${file}`
      : `✗ ${label} 加载失败: ${res.out.trim() || `exit ${res.code}`}\n    plist 已写入 ${file}`);
    if (!res.ok) allOk = false;
  }
  console.log('');
  console.log('注意事项:');
  console.log('  · LaunchAgent 只在该 macOS 用户已登录桌面时运行；紫鸟浏览器需要图形界面。');
  console.log('  · 机器休眠时错过的任务会在唤醒后补跑一次。');
  console.log('  · 立即验证一次（不必等到点）:');
  console.log(`      launchctl kickstart -p gui/${uid}/${LABEL_PREFIX}.${CHECK}.${slotsFrom(config)[0].name}`);
  return allOk ? 0 : 1;
}

function macUninstall(config) {
  const dir = macDir();
  for (const slot of slotsFrom(config)) {
    const label = `${LABEL_PREFIX}.${CHECK}.${slot.name}`;
    const file = path.join(dir, `${label}.plist`);
    const res = run('launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
    if (!res.ok) run('launchctl', ['unload', '-w', file]);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`✓ 已移除 ${label}`);
    } else {
      console.log(`- 未安装 ${label}`);
    }
  }
  const dashboardLabel = `${LABEL_PREFIX}.dashboard`;
  const dashboardFile = path.join(dir, `${dashboardLabel}.plist`);
  let dashboard = run('launchctl', ['bootout', `gui/${process.getuid()}/${dashboardLabel}`]);
  if (!dashboard.ok) run('launchctl', ['unload', '-w', dashboardFile]);
  if (fs.existsSync(dashboardFile)) {
    fs.unlinkSync(dashboardFile);
    console.log(`✓ 已移除 ${dashboardLabel}`);
  }
  return 0;
}

function macStatus(config) {
  for (const slot of slotsFrom(config)) {
    const label = `${LABEL_PREFIX}.${CHECK}.${slot.name}`;
    const file = path.join(macDir(), `${label}.plist`);
    const res = run('launchctl', ['print', `gui/${process.getuid()}/${label}`]);
    const local = beijingToLocal(slot.at);
    console.log(`${res.ok ? '✓ 已加载' : '✗ 未加载'}  ${label}`);
    console.log(`    北京 ${slot.at} → 本机 ${pad(local.hour)}:${pad(local.minute)}`);
    console.log(`    plist: ${fs.existsSync(file) ? file : '（文件不存在）'}`);
    if (res.ok) {
      const runs = /runs = (\d+)/.exec(res.out);
      const code = /last exit code = (\d+)/.exec(res.out);
      if (runs) console.log(`    已执行 ${runs[1]} 次${code ? `，最后退出码 ${code[1]}` : ''}`);
    }
  }
  const dashboardLabel = `${LABEL_PREFIX}.dashboard`;
  const dashboardFile = path.join(macDir(), `${dashboardLabel}.plist`);
  const dashboard = run('launchctl', ['print', `gui/${process.getuid()}/${dashboardLabel}`]);
  console.log(`${dashboard.ok ? '✓ 已加载' : '✗ 未加载'}  ${dashboardLabel}（看板）`);
  console.log(`    plist: ${fs.existsSync(dashboardFile) ? dashboardFile : '（文件不存在）'}`);
  return 0;
}

// =========================================================== Linux / systemd

function systemdDir() {
  const d = path.join(os.homedir(), '.config', 'systemd', 'user');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function hasSystemd() {
  return run('systemctl', ['--user', '--version']).ok;
}

function linuxInstall(config, opts) {
  if (!hasSystemd()) {
    console.log('✗ 找不到 systemctl --user，无法安装 systemd 定时器。');
    printCron(config);
    return 1;
  }
  const dir = systemdDir();
  let allOk = true;
  const units = [];

  for (const slot of slotsFrom(config)) {
    const local = beijingToLocal(slot.at);
    const unit = `${UNIT_PREFIX}-${CHECK}-${slot.name}`;
    const svcFile = path.join(dir, `${unit}.service`);
    const tmrFile = path.join(dir, `${unit}.timer`);

    fs.writeFileSync(svcFile, serviceUnit({
      unit, nodeBin: process.execPath, cliPath: path.join(ROOT, 'src', 'cli.js'),
      cwd: ROOT, args: jobArgs(slot, opts), display: opts.display,
    }));
    fs.writeFileSync(tmrFile, timerUnit({
      unit, hour: local.hour, minute: local.minute, beijingAt: slot.at,
    }));
    units.push({ unit, slot, local, svcFile, tmrFile });
  }

  const reload = run('systemctl', ['--user', 'daemon-reload']);
  if (!reload.ok) console.log(`⚠ daemon-reload 失败: ${reload.out.trim()}`);

  for (const u of units) {
    const res = run('systemctl', ['--user', 'enable', '--now', `${u.unit}.timer`]);
    console.log(res.ok
      ? `✓ ${u.unit}.timer\n    北京 ${u.slot.at} → 本机 ${pad(u.local.hour)}:${pad(u.local.minute)}\n    ${u.svcFile}`
      : `✗ ${u.unit}.timer 启用失败: ${res.out.trim() || `exit ${res.code}`}\n    unit 已写入 ${u.svcFile}`);
    if (!res.ok) allOk = false;
  }

  console.log('');
  console.log('注意事项:');
  console.log('  · 紫鸟浏览器是图形程序，必须有可用的桌面会话（X11/Wayland）。');
  console.log('  · 让 systemd 用户服务拿到显示环境，桌面登录后执行一次:');
  console.log('      systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY');
  if (!opts.display) {
    console.log('    或安装时显式指定: node src/schedule.js install --display :0');
  }
  console.log('  · 想在用户未登录时也运行（需自行确保有显示环境）:');
  console.log(`      sudo loginctl enable-linger ${os.userInfo().username}`);
  console.log('  · Persistent=true：关机期间错过的任务会在开机后补跑一次。');
  console.log('  · 立即验证一次（不必等到点）:');
  console.log(`      systemctl --user start ${units[0].unit}.service`);
  console.log(`      journalctl --user -u ${units[0].unit}.service -n 50 --no-pager`);
  return allOk ? 0 : 1;
}

function linuxUninstall(config) {
  const dir = systemdDir();
  for (const slot of slotsFrom(config)) {
    const unit = `${UNIT_PREFIX}-${CHECK}-${slot.name}`;
    run('systemctl', ['--user', 'disable', '--now', `${unit}.timer`]);
    let removed = false;
    for (const f of [path.join(dir, `${unit}.timer`), path.join(dir, `${unit}.service`)]) {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        removed = true;
      }
    }
    console.log(removed ? `✓ 已移除 ${unit}` : `- 未安装 ${unit}`);
  }
  run('systemctl', ['--user', 'daemon-reload']);
  return 0;
}

function linuxStatus(config) {
  if (!hasSystemd()) {
    console.log('✗ 找不到 systemctl --user。');
    printCron(config);
    return 1;
  }
  const dir = systemdDir();
  for (const slot of slotsFrom(config)) {
    const unit = `${UNIT_PREFIX}-${CHECK}-${slot.name}`;
    const tmrFile = path.join(dir, `${unit}.timer`);
    const active = run('systemctl', ['--user', 'is-active', `${unit}.timer`]);
    const enabled = run('systemctl', ['--user', 'is-enabled', `${unit}.timer`]);
    const local = beijingToLocal(slot.at);
    console.log(`${active.ok ? '✓ 运行中' : '✗ 未运行'}  ${unit}.timer  (${enabled.out.trim() || 'disabled'})`);
    console.log(`    北京 ${slot.at} → 本机 ${pad(local.hour)}:${pad(local.minute)}`);
    console.log(`    unit: ${fs.existsSync(tmrFile) ? tmrFile : '（文件不存在）'}`);
  }
  const timers = run('systemctl', ['--user', 'list-timers', `${UNIT_PREFIX}-*`, '--no-pager']);
  if (timers.ok && timers.out.trim()) {
    console.log('');
    console.log(timers.out.trim());
  }
  return 0;
}


// ========================================================= Windows / schtasks

const WIN_PREFIX = 'AmzGuard';
const winName = (s) => `\\${WIN_PREFIX}\\${s}`;

function winInstall(config, opts) {
  const nodeBin = process.execPath;
  const cliPath = path.join(ROOT, 'src', 'cli.js');
  const serverPath = path.join(ROOT, 'src', 'server.js');
  const port = opts.port || process.env.PORT || 80;
  let allOk = true;

  for (const slot of slotsFrom(config)) {
    const local = beijingToLocal(slot.at);
    const taskName = winName(`slot-${slot.name}`);
    const args = winCheckTask({
      taskName, nodeBin, cliPath, cwd: ROOT, slot: slot.name,
      hour: local.hour, minute: local.minute,
    }).slice(1);
    const res = run('schtasks', args);
    console.log(res.ok
      ? `✓ ${taskName}\n    北京 ${slot.at} → 本机 ${pad(local.hour)}:${pad(local.minute)}`
      : `✗ ${taskName} 创建失败: ${res.out.trim() || `exit ${res.code}`}`);
    if (!res.ok) allOk = false;
  }

  if (!opts.noServer) {
    const taskName = winName('dashboard');
    const res = run('schtasks', winServerTask({ taskName, nodeBin, serverPath, cwd: ROOT, port }).slice(1));
    console.log(res.ok ? `✓ ${taskName}（开机自启，端口 ${port}）` : `✗ ${taskName} 创建失败: ${res.out.trim()}`);
    if (!res.ok) allOk = false;
  }

  console.log('');
  console.log('注意事项:');
  console.log('  · 检查任务用 /IT（仅在用户登录时运行）—— 紫鸟浏览器需要交互式桌面会话。');
  console.log('    这台机器必须保持登录状态，锁屏可以，注销不行。');
  console.log('  · 看板任务以 SYSTEM 开机自启，注销后仍然在跑。');
  console.log('  · 立即验证一次（不必等到点）:');
  console.log(`      schtasks /Run /TN "${winName(`slot-${slotsFrom(config)[0].name}`)}"`);
  console.log(`      schtasks /Query /TN "${winName(`slot-${slotsFrom(config)[0].name}`)}" /V /FO LIST`);
  return allOk ? 0 : 1;
}

function winUninstall(config) {
  for (const slot of slotsFrom(config)) {
    const taskName = winName(`slot-${slot.name}`);
    const res = run('schtasks', ['/Delete', '/F', '/TN', taskName]);
    console.log(res.ok ? `✓ 已移除 ${taskName}` : `- 未安装 ${taskName}`);
  }
  const res = run('schtasks', ['/Delete', '/F', '/TN', winName('dashboard')]);
  console.log(res.ok ? `✓ 已移除 ${winName('dashboard')}` : `- 未安装 ${winName('dashboard')}`);
  return 0;
}

function winStatus(config) {
  for (const slot of slotsFrom(config)) {
    const taskName = winName(`slot-${slot.name}`);
    const res = run('schtasks', ['/Query', '/TN', taskName, '/FO', 'LIST']);
    const local = beijingToLocal(slot.at);
    console.log(`${res.ok ? '✓ 已注册' : '✗ 未注册'}  ${taskName}`);
    console.log(`    北京 ${slot.at} → 本机 ${pad(local.hour)}:${pad(local.minute)}`);
    if (res.ok) {
      const next = /Next Run Time:\s*(.+)/i.exec(res.out);
      const last = /Last Result:\s*(.+)/i.exec(res.out);
      if (next) console.log(`    下次运行: ${next[1].trim()}`);
      if (last) console.log(`    上次结果: ${last[1].trim()}`);
    }
  }
  const d = run('schtasks', ['/Query', '/TN', winName('dashboard'), '/FO', 'LIST']);
  console.log(`${d.ok ? '✓ 已注册' : '✗ 未注册'}  ${winName('dashboard')}（看板）`);
  return 0;
}

// ==================================================================== fallback

function printCron(config) {
  console.log('');
  console.log('改用 cron（时间已换算为本机时区）:');
  console.log('  crontab -e  然后加入:');
  for (const line of cronLines({
    slots: slotsFrom(config), root: ROOT, nodeBin: process.execPath, command: 'run-slot',
  })) {
    console.log(`    ${line}`);
  }
}

// ======================================================================= main

const action = process.argv[2] || 'status';
const opts = {
  headless: process.argv.includes('--headless'),
  display: (() => {
    const i = process.argv.indexOf('--display');
    return i > -1 ? process.argv[i + 1] : null;
  })(),
  port: (() => {
    const i = process.argv.indexOf('--port');
    return i > -1 ? Number(process.argv[i + 1]) : null;
  })(),
  noServer: process.argv.includes('--no-server'),
};

const { config } = loadConfig();

const TABLE = {
  darwin: { install: macInstall, uninstall: macUninstall, status: macStatus },
  linux: { install: linuxInstall, uninstall: linuxUninstall, status: linuxStatus },
  win32: { install: winInstall, uninstall: winUninstall, status: winStatus },
};

try {
  const impl = TABLE[process.platform];
  if (!impl) {
    console.error(`不支持的平台: ${process.platform}（支持 Windows schtasks / macOS launchd / Linux systemd）`);
    printCron(config);
    process.exit(2);
  }
  const fn = impl[action];
  if (!fn) {
    console.error('用法: node src/schedule.js <install|uninstall|status> [--headless] [--display :0]');
    process.exit(2);
  }
  banner(config);
  const code = fn(config, opts);
  if (action === 'install' && localTz() !== TZ) {
    console.log('');
    console.log('⚠ 本机时区不是 Asia/Shanghai：本地夏令时切换后需重新执行安装以修正触发时间。');
  }
  process.exit(code);
} catch (e) {
  console.error(`排程操作失败: ${e.message}`);
  process.exit(2);
}
