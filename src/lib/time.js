// Beijing-time helpers. Everything user-facing is Asia/Shanghai regardless of machine TZ.
export const TZ = 'Asia/Shanghai';

const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** @returns {{year:string,month:string,day:string,hour:string,minute:string,second:string}} */
export function bjParts(d = new Date()) {
  const p = {};
  for (const { type, value } of FMT.formatToParts(d)) {
    if (type !== 'literal') p[type] = value;
  }
  // hour12:false can render midnight as "24" on some ICU builds
  if (p.hour === '24') p.hour = '00';
  return p;
}

/** "2026-08-25" */
export function bjDateKey(d = new Date()) {
  const p = bjParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "20260825-080012-042" — safe for filenames and unique within a minute. */
export function bjStamp(d = new Date()) {
  const p = bjParts(d);
  return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/** "2026-08-25T08:00:12+08:00" */
export function bjIso(d = new Date()) {
  const p = bjParts(d);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}

/** "2026-08-25 08:00:12" */
export function bjHuman(d = new Date()) {
  const p = bjParts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** Minutes since Beijing midnight. */
export function bjMinutes(d = new Date()) {
  const p = bjParts(d);
  return Number(p.hour) * 60 + Number(p.minute);
}

export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`invalid HH:MM: ${s}`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new Error(`invalid HH:MM: ${s}`);
  return { hour: h, minute: mi, minutes: h * 60 + mi };
}

/**
 * Which scheduled slot does `d` belong to? Returns the slot name when the run is
 * within `toleranceMin` of a configured slot, otherwise "adhoc".
 */
export function detectSlot(slots, d = new Date(), toleranceMin = 90) {
  const now = bjMinutes(d);
  let best = null;
  let bestDist = Infinity;
  for (const s of slots || []) {
    const dist = Math.abs(parseHHMM(s.at).minutes - now);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best && bestDist <= toleranceMin ? best.name : 'adhoc';
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
