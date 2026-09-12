import fs from 'node:fs';
import path from 'node:path';

/**
 * Tiny JSON store for cross-run comparison — previous status and previous AHR
 * score per store, so a run can say "score dropped 256 -> 210" rather than just
 * reporting today's number.
 */
export function createStateStore({ outDir, name }) {
  const file = path.join(outDir, 'state', `${name}.json`);

  function validate(value) {
    const valid = value && typeof value === 'object' && !Array.isArray(value)
      && value.version === 1
      && value.stores && typeof value.stores === 'object' && !Array.isArray(value.stores);
    if (!valid) throw new Error('状态结构或版本无效');
    return value;
  }

  function read() {
    if (!fs.existsSync(file)) return { version: 1, stores: {} };
    try {
      return validate(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      // A damaged comparison baseline must never be mistaken for a first run:
      // doing so would hide score drops and replay every "new" activity.
      throw new Error(`状态文件损坏，已停止覆盖有效基线: ${file} (${error.message})`);
    }
  }

  function write(state) {
    validate(state);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(file), 0o700); } catch { /* non-POSIX */ }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file); // atomic, so a crash mid-write cannot corrupt it
    fs.chmodSync(file, 0o600);
  }

  return { file, read, write };
}
