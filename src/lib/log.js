import fs from 'node:fs';
import path from 'node:path';
import { redactText } from './redact.js';
import { bjHuman } from './time.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const COLOR = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

export function createLogger({ level = 'info', file = null, useColor = process.stdout.isTTY } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(file), 0o700); } catch { /* non-POSIX */ }
    if (fs.existsSync(file)) {
      try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
    }
    stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
  }

  const emit = (lvl, args) => {
    if ((LEVELS[lvl] ?? 0) < min) return;
    const ts = bjHuman();
    const msg = redactText(args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' '));
    const plain = `${ts} [${lvl.toUpperCase().padEnd(5)}] ${msg}`;
    const out = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    out.write(useColor ? `${COLOR[lvl] || ''}${plain}${COLOR.reset}\n` : `${plain}\n`);
    if (stream) stream.write(`${plain}\n`);
  };

  return {
    level,
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    /** Prints without timestamp/level — for final human-facing summaries. */
    plain: (s = '') => {
      const safe = redactText(s);
      process.stdout.write(`${safe}\n`);
      if (stream) stream.write(`${safe}\n`);
    },
    close: () => new Promise((r) => (stream ? stream.end(r) : r())),
  };
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
