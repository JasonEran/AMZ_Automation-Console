import os from 'node:os';
import { bjParts, parseHHMM, TZ } from './time.js';

/**
 * Pure generators for scheduler unit files — kept separate from schedule.js so
 * they can be asserted in the offline self-test. The Linux branch in particular
 * cannot be exercised on a macOS dev box any other way.
 */

export const pad = (n) => String(n).padStart(2, '0');

/**
 * Beijing HH:MM -> the same instant in the machine's local HH:MM.
 * Beijing is UTC+8 year-round (no DST), so subtracting 8h yields the instant;
 * `Date#getHours` then renders it in whatever zone the machine is set to.
 */
export function beijingToLocal(hhmm, now = new Date()) {
  const { hour, minute } = parseHHMM(hhmm);
  const p = bjParts(now);
  const instant = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour - 8, minute, 0));
  return { hour: instant.getHours(), minute: instant.getMinutes() };
}

/** Both schedulers hand the job a minimal PATH; binary locations must be explicit. */
export function pathEnv(platform = process.platform, home = os.homedir()) {
  const dirs = platform === 'darwin'
    ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']
    : ['/usr/local/bin', '/usr/local/sbin', `${home}/.local/bin`, `${home}/.npm-global/bin`];
  return [...dirs, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
}

export function macPlist({ label, nodeBin, cliPath, cwd, args, hour, minute, home = os.homedir() }) {
  const argXml = [nodeBin, cliPath, ...args].map((a) => `      <string>${a}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${cwd}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${pathEnv('darwin', home)}</string>
    <key>TZ</key><string>${TZ}</string>
    <key>HOME</key><string>${home}</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}

export function macServerPlist({ label, nodeBin, serverPath, cwd, port = 4173, home = os.homedir(), logDir }) {
  const logs = logDir || `${cwd}/out/logs`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${serverPath}</string>
  </array>
  <key>WorkingDirectory</key><string>${cwd}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${pathEnv('darwin', home)}</string>
    <key>TZ</key><string>${TZ}</string>
    <key>HOME</key><string>${home}</string>
    <key>HOST</key><string>127.0.0.1</string>
    <key>PORT</key><string>${port}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${logs}/dashboard.stdout.log</string>
  <key>StandardErrorPath</key><string>${logs}/dashboard.stderr.log</string>
</dict>
</plist>
`;
}

export function serviceUnit({ unit, nodeBin, cliPath, cwd, args, display, home = os.homedir() }) {
  const exec = [nodeBin, cliPath, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  const lines = [
    '[Unit]',
    `Description=亚马逊店铺健康检查 (${unit})`,
    'After=graphical-session.target',
    '',
    '[Service]',
    'Type=oneshot',
    `WorkingDirectory=${cwd}`,
    `Environment=TZ=${TZ}`,
    `Environment=PATH=${pathEnv('linux', home)}`,
    `Environment=HOME=${home}`,
  ];
  // Ziniao is a GUI app; with no display the store browser cannot launch at all.
  if (display) lines.push(`Environment=DISPLAY=${display}`);
  lines.push(
    `ExecStart=${exec}`,
    // Exit 1 means "anomalies found" — a successful check, not a unit failure.
    'SuccessExitStatus=0 1',
    '',
  );
  return `${lines.join('\n')}\n`;
}

export function timerUnit({ unit, hour, minute, beijingAt }) {
  return `[Unit]
Description=亚马逊店铺健康检查定时器 (${unit}) — 北京时间 ${beijingAt}

[Timer]
OnCalendar=*-*-* ${pad(hour)}:${pad(minute)}:00
Persistent=true
AccuracySec=1min

[Install]
WantedBy=timers.target
`;
}

export function cronLines({ slots, root, nodeBin, command = 'run-slot', platform = process.platform, home = os.homedir() }) {
  const out = [`PATH=${pathEnv(platform, home)}`, `TZ=${TZ}`];
  for (const slot of slots) {
    const l = beijingToLocal(slot.at);
    out.push(`${l.minute} ${l.hour} * * *  cd ${root} && ${nodeBin} src/cli.js ${command} ${slot.name}   # 北京 ${slot.at}`);
  }
  return out;
}

/**
 * Windows Task Scheduler commands.
 *
 * Two different task kinds, for two different reasons:
 *  - Check tasks use /IT (interactive only) and run as the logged-on user,
 *    because Ziniao is a GUI application and cannot run in session 0.
 *  - The dashboard task runs ONSTART as SYSTEM, since it is a plain HTTP server
 *    that should survive logoff.
 *
 * Times are already converted to the machine's local clock by the caller.
 */
export function winCheckTask({ taskName, nodeBin, cliPath, cwd, slot, hour, minute }) {
  const tr = `cmd /c cd /d "${cwd}" && "${nodeBin}" "${cliPath}" run-slot ${slot}`;
  return [
    'schtasks', '/Create', '/F',
    '/TN', taskName,
    '/TR', tr,
    '/SC', 'DAILY',
    '/ST', `${pad(hour)}:${pad(minute)}`,
    '/IT',
  ];
}

export function winServerTask({ taskName, nodeBin, serverPath, cwd, port }) {
  const tr = `cmd /c cd /d "${cwd}" && set PORT=${port} && "${nodeBin}" "${serverPath}"`;
  return [
    'schtasks', '/Create', '/F',
    '/TN', taskName,
    '/TR', tr,
    '/SC', 'ONSTART',
    '/RU', 'SYSTEM',
    '/RL', 'HIGHEST',
  ];
}

export function winTaskName(prefix, suffix) {
  return `\\${prefix}\\${suffix}`;
}
