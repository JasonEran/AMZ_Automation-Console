import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAX_XML = 8 * 1024 * 1024;
const FIELDS = [
  ['submitted', 'B4', 'E4', 'Number of SKUs processed'],
  ['success', 'B5', 'E5', 'Number of SKUs successful'],
  ['successfulWithErrors', 'B6', 'E6', 'Number of SKUs successful with other errors'],
  ['failed', 'B7', 'E7', 'Number of SKUs unsuccessful due to errors'],
  ['warning', 'B8', 'E8', 'Number of SKUs with warnings'],
  ['errorTotal', 'B12', 'H12', 'Total number of errors'],
];
const bad = () => { throw new Error('Unverified processing report summary'); };
const utf8 = buffer => new TextDecoder('utf-8', { fatal: true }).decode(buffer);
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i; for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  CRC_TABLE[i] = crc >>> 0;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function archive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 30 || buffer.length > 20 * 1024 * 1024
    || buffer.readUInt32LE(0) !== 0x04034b50) bad();
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) bad();
  const count = buffer.readUInt16LE(end + 10), size = buffer.readUInt32LE(end + 12), offset = buffer.readUInt32LE(end + 16);
  if (!count || count > 512 || buffer.readUInt16LE(end + 8) !== count || offset + size !== end) bad();
  const members = new Map(), aliases = new Set(), ranges = [];
  let cursor = offset, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) bad();
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16), compressed = buffer.readUInt32LE(cursor + 20), length = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extra = buffer.readUInt16LE(cursor + 30), comment = buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42), next = cursor + 46 + nameLength + extra + comment;
    if (next > end || flags & ~0x080e || flags & 1 || ![0, 8].includes(method)
      || buffer.readUInt16LE(cursor + 34) || compressed === 0xffffffff || length === 0xffffffff || local + 30 > offset) bad();
    const name = utf8(buffer.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!name || /[\\\x00-\x20]/.test(name) || name.startsWith('/') || name.split('/').some(part => part === '.' || part === '..')
      || aliases.has(name.toLowerCase()) || /(?:^|\/)(?:vbaProject\.bin|activeX|embeddings|externalLinks)(?:\/|$)/i.test(name)) bad();
    aliases.add(name.toLowerCase()); expanded += length;
    if (expanded > 100 * 1024 * 1024 || (length > 10 * 1024 * 1024 && length > Math.max(1, compressed) * 100)) bad();
    if (buffer.readUInt32LE(local) !== 0x04034b50 || buffer.readUInt16LE(local + 6) !== flags
      || buffer.readUInt16LE(local + 8) !== method) bad();
    const localNameLength = buffer.readUInt16LE(local + 26), localExtra = buffer.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtra;
    if (start + compressed > offset || utf8(buffer.subarray(local + 30, local + 30 + localNameLength)) !== name) bad();
    for (const [at, expected] of [[14, crc], [18, compressed], [22, length]]) {
      const value = buffer.readUInt32LE(local + at);
      if (value !== expected && (!(flags & 8) || value !== 0)) bad();
    }
    ranges.push([local, start + compressed]);
    members.set(name, { start, compressed, length, method, crc }); cursor = next;
  }
  if (cursor !== end) bad();
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) bad();
  return name => {
    const member = members.get(name);
    if (!member || member.length > MAX_XML) bad();
    const input = buffer.subarray(member.start, member.start + member.compressed);
    let value;
    if (member.method === 0) value = input;
    else {
      const result = inflateRawSync(input, { maxOutputLength: MAX_XML, info: true });
      if (result.engine.bytesWritten !== input.length) bad();
      value = result.buffer;
    }
    if (value.length !== member.length || crc32(value) !== member.crc) bad();
    return utf8(value);
  };
}

function decoded(value) {
  return value.replace(/&(?:#x([a-f0-9]+)|#([0-9]+)|(amp|lt|gt|quot|apos));|&/gi, (match, hex, decimal, entity) => {
    if (match === '&') bad();
    if (entity) {
      const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      if (!Object.hasOwn(entities, entity)) bad(); return entities[entity];
    }
    const n = Number.parseInt(hex || decimal, hex ? 16 : 10);
    if (!(n === 9 || n === 10 || n === 13 || n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff))) bad();
    return String.fromCodePoint(n);
  });
}

// A deliberately restricted XML reader: no DTD, declared entities, processing
// instructions or changes to the namespaces used for evidence. Namespaced
// Office extension elements are retained as opaque names, never main elements.
// Unknown OOXML variants provide no evidence instead of invoking a general XML engine.
function xml(text, namespace, rootName) {
  if (text.length > MAX_XML || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) bad();
  text = text.replace(/^\uFEFF/, '').replace(/^<\?xml\s+[^?]*\?>/, '');
  const stack = [], roots = []; let cursor = 0, nodes = 0;
  const name = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;
  while (cursor < text.length) {
    if (text.startsWith('<!--', cursor)) {
      const end = text.indexOf('-->', cursor + 4);
      if (end < 0 || text.slice(cursor + 4, end).includes('--')) bad(); cursor = end + 3; continue;
    }
    if (text[cursor] !== '<') {
      let end = text.indexOf('<', cursor); if (end < 0) end = text.length;
      const value = decoded(text.slice(cursor, end));
      if (stack.length) stack.at(-1).text += value; else if (value.trim()) bad();
      cursor = end; continue;
    }
    const match = /^<(?:[^<>"']|"[^"<]*"|'[^'<]*')*>/.exec(text.slice(cursor));
    if (!match) bad(); const token = match[0]; cursor += token.length;
    if (token.startsWith('</')) {
      const close = token.slice(2, -1).trim();
      if (!name.test(close) || stack.pop()?.name !== close) bad(); continue;
    }
    const head = /^<([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?)/.exec(token);
    if (!head || ++nodes > 200000 || stack.length >= 64) bad();
    const attributes = Object.create(null), selfClosing = token.endsWith('/>');
    let rest = token.slice(head[0].length, selfClosing ? -2 : -1);
    while (rest.trim()) {
      const attr = /^\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest);
      if (!attr || Object.hasOwn(attributes, attr[1])) bad();
      attributes[attr[1]] = decoded(attr[2] ?? attr[3]);
      if (attr[1] === 'xmlns' && attributes[attr[1]] !== namespace
        || attr[1] === 'xmlns:r' && attributes[attr[1]] !== OFFICE_REL) bad();
      rest = rest.slice(attr[0].length);
    }
    const node = { name: head[1], attributes, children: [], text: '' };
    if (stack.length) stack.at(-1).children.push(node); else roots.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length || roots.length !== 1 || roots[0].name !== rootName || roots[0].attributes.xmlns !== namespace) bad();
  return roots[0];
}
const children = (node, name) => node.children.filter(child => child.name === name);
function single(node, name) { const found = children(node, name); if (found.length !== 1) bad(); return found[0]; }
function all(node, name, result = []) { if (node.name === name) result.push(node); for (const child of node.children) all(child, name, result); return result; }
function texts(node) { return all(node, 't').map(value => value.text).join(''); }
function integer(value) { if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,7})$/.test(value) || Number(value) > 10000000) bad(); return Number(value); }

/** Parse only the verified Feed Processing Summary aggregate cells. The
 * original attachment remains private; no SKU, formula or raw XML is returned.
 * Any unsupported, incomplete or inconsistent evidence yields null. */
export function readProductUploadReportSummary(buffer) {
  try {
    const read = archive(buffer), workbook = xml(read('xl/workbook.xml'), MAIN, 'workbook');
    if (workbook.attributes['xmlns:r'] !== OFFICE_REL) bad();
    const sheets = children(single(workbook, 'sheets'), 'sheet'), names = new Set(), ids = new Set();
    for (const sheet of sheets) {
      const name = sheet.attributes.name, id = sheet.attributes['r:id'];
      if (!name || !id || names.has(name) || ids.has(id)) bad(); names.add(name); ids.add(id);
    }
    const summary = sheets.filter(sheet => sheet.attributes.name === 'Feed Processing Summary');
    if (summary.length !== 1) bad();
    const relationships = children(xml(read('xl/_rels/workbook.xml.rels'), REL, 'Relationships'), 'Relationship');
    const rels = new Map();
    for (const relationship of relationships) {
      const attr = relationship.attributes;
      if (!attr.Id || rels.has(attr.Id) || attr.TargetMode || !attr.Target || /[:\\?#\x00-\x20]/.test(attr.Target)
        || attr.Target.startsWith('/') || attr.Target.split('/').includes('..')) bad();
      rels.set(attr.Id, attr);
    }
    const rel = rels.get(summary[0].attributes['r:id']);
    if (rel?.Type !== `${OFFICE_REL}/worksheet` || !/^worksheets\/[A-Za-z0-9_.-]+\.xml$/.test(rel.Target)) bad();
    const sheetXml = read(path.posix.join('xl', rel.Target)), sheet = xml(sheetXml, MAIN, 'worksheet');
    if (all(sheet, 'f').length || /<(?:[A-Za-z_][A-Za-z0-9_.-]*:)?f[\s/>]/.test(sheetXml)) bad();
    const cells = new Map();
    for (const cell of all(single(sheet, 'sheetData'), 'c')) {
      const address = cell.attributes.r;
      if (!/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(address || '') || cells.has(address)) bad();
      cells.set(address, cell);
    }
    let strings = null;
    function label(cell) {
      if (!cell) bad();
      if (cell.attributes.t === 'inlineStr') return texts(single(cell, 'is'));
      if (cell.attributes.t !== 's') bad();
      if (!strings) {
        const relations = relationships.filter(item => item.attributes.Type === `${OFFICE_REL}/sharedStrings`);
        if (relations.length !== 1 || relations[0].attributes.Target !== 'sharedStrings.xml') bad();
        strings = children(xml(read('xl/sharedStrings.xml'), MAIN, 'sst'), 'si');
      }
      const index = integer(single(cell, 'v').text);
      if (!strings[index]) bad(); return texts(strings[index]);
    }
    const knownLabels = new Set(FIELDS.map(field => field[3])), occurrences = new Map();
    for (const cell of cells.values()) {
      if (!['s', 'inlineStr'].includes(cell.attributes.t)) continue;
      const value = label(cell);
      if (knownLabels.has(value)) occurrences.set(value, (occurrences.get(value) || 0) + 1);
    }
    const values = {};
    for (const [field, labelCell, numberCell, expectedLabel] of FIELDS) {
      if (label(cells.get(labelCell)) !== expectedLabel || occurrences.get(expectedLabel) !== 1) bad();
      const cell = cells.get(numberCell);
      if (!cell || cell.attributes.t && cell.attributes.t !== 'n' || cell.children.some(child => child.name !== 'v')) bad();
      values[field] = integer(single(cell, 'v').text);
    }
    if (values.success > values.submitted || values.failed > values.submitted || values.warning > values.submitted
      || values.successfulWithErrors > values.success || values.success + values.failed > values.submitted) bad();
    return { source: 'AMAZON_PROCESSING_REPORT', counts: { submitted: values.submitted, success: values.success,
      failed: values.failed, warning: values.warning }, successfulWithErrors: values.successfulWithErrors, errorTotal: values.errorTotal };
  } catch { return null; }
}
