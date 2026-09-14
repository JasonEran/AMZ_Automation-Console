import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { readProductUploadReportSummary } from '../src/lib/product-upload-report-summary.js';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const LABELS = ['Number of SKUs processed', 'Number of SKUs successful', 'Number of SKUs successful with other errors',
  'Number of SKUs unsuccessful due to errors', 'Number of SKUs with warnings', 'Total number of errors'];
const EXPECTED = { source: 'AMAZON_PROCESSING_REPORT', counts: { submitted: 3, success: 2, failed: 1, warning: 1 },
  successfulWithErrors: 1, errorTotal: 4 };
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries, { method = 8 } = {}) {
  const locals = [], directory = []; let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name), raw = Buffer.from(text), compressed = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed); directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
function fixture({ inline = false, counts = [3, 2, 1, 1, 1, 4] } = {}) {
  const workbook = `<workbook xmlns="${NS}" xmlns:r="${R}"><sheets><sheet name="Feed Processing Summary" sheetId="1" r:id="summary"/></sheets></workbook>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="summary" Type="${R}/worksheet" Target="worksheets/report.xml"/><Relationship Id="strings" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const shared = `<sst xmlns="${NS}">${LABELS.map(label => `<si><t>${label}</t></si>`).join('')}</sst>`;
  const rows = [4, 5, 6, 7, 8, 12].map((row, i) => `<row r="${row}"><c r="B${row}" t="${inline ? 'inlineStr' : 's'}">${inline ? `<is><t>${LABELS[i]}</t></is>` : `<v>${i}</v>`}</c><c r="${i === 5 ? 'H' : 'E'}${row}"><v>${counts[i]}</v></c></row>`).join('');
  return new Map([['xl/workbook.xml', workbook], ['xl/_rels/workbook.xml.rels', rels],
    ['xl/sharedStrings.xml', shared], ['xl/worksheets/report.xml', `<worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`]]);
}
function changed(file, change, options) {
  const entries = fixture(options); entries.set(file, change(entries.get(file))); return zip([...entries]);
}
const SHEET = 'xl/worksheets/report.xml', WORKBOOK = 'xl/workbook.xml', RELS = 'xl/_rels/workbook.xml.rels', STRINGS = 'xl/sharedStrings.xml';

test('processing summary follows workbook relationships and exact labels for stored, deflated and inline strings', () => {
  for (const method of [0, 8]) for (const inline of [false, true]) {
    assert.deepEqual(readProductUploadReportSummary(zip([...fixture({ inline })], { method })), EXPECTED);
  }
  const entries = fixture();
  entries.set(STRINGS, entries.get(STRINGS).replace('<si><t>Number of SKUs processed</t></si>', '<si><r><t>Number of SKUs </t></r><r><t>processed</t></r></si>'));
  assert.deepEqual(readProductUploadReportSummary(zip([...entries])), EXPECTED);
});

test('summary returns only aggregate counts and preserves explicit zero values', () => {
  const entries = fixture({ counts: [1, 1, 0, 0, 0, 0] });
  entries.set(STRINGS, entries.get(STRINGS).replace('</sst>', '<si><t>SYNTHETIC_PRIVATE_ITEM</t></si></sst>'));
  const result = readProductUploadReportSummary(zip([...entries]));
  assert.deepEqual(result, { source: 'AMAZON_PROCESSING_REPORT', counts: { submitted: 1, success: 1, failed: 0, warning: 0 }, successfulWithErrors: 0, errorTotal: 0 });
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_ITEM|sheet|xml|path|sku|filename|buffer/);
  assert.equal(result.counts.failed, 0); assert.equal(result.counts.warning, 0);
});

test('missing, renamed, relinked or duplicate summary worksheets cannot produce evidence', () => {
  for (const mutate of [s => s.replace('Feed Processing Summary', 'Another Summary'),
    s => s.replace('</sheets>', '<sheet name="Feed Processing Summary" r:id="other"/></sheets>'),
    s => s.replace('r:id="summary"', 'r:id="missing"'), s => s.replace('<sheets>', '<sheets/><sheets>'),
    s => s.replace(`xmlns:r="${R}"`, 'xmlns:r="https://example.invalid/relations"')]) {
    assert.equal(readProductUploadReportSummary(changed(WORKBOOK, mutate)), null);
  }
  assert.equal(readProductUploadReportSummary(zip([...fixture()].filter(([name]) => name !== WORKBOOK))), null);
});

test('summary requires both exact labels and number cells and rejects duplicate labels or cells', () => {
  assert.equal(readProductUploadReportSummary(changed(STRINGS, s => s.replace('Number of SKUs processed', 'Number of views'))), null);
  assert.equal(readProductUploadReportSummary(changed(SHEET, s => s.replace('<v>0</v>', '<v>999999</v>'))), null);
  for (const mutate of [s => s.replace('<c r="E4"><v>3</v></c>', ''),
    s => s.replace('r="B4"', 'r="B3"'),
    s => s.replace('</row>', '<c r="E4"><v>3</v></c></row>'),
    s => s.replace('</sheetData>', '<row r="99"><c r="B99" t="s"><v>0</v></c></row></sheetData>'),
    s => s.replace('<c r="E4"><v>3</v></c>', '<c r="E4"><v>3</v><v>3</v></c>')]) {
    assert.equal(readProductUploadReportSummary(changed(SHEET, mutate)), null);
  }
});

test('numbers must be explicit bounded nonnegative integers with consistent SKU totals', () => {
  for (const value of ['-1', '1.5', '1e2', 'NaN', '', ' 3 ', '10000001', '03', '+3']) {
    assert.equal(readProductUploadReportSummary(zip([...fixture({ counts: [value, 2, 1, 1, 1, 4] })])), null, value);
  }
  for (const counts of [[1, 2, 0, 0, 0, 0], [1, 1, 2, 0, 0, 0], [1, 1, 0, 1, 0, 0], [1, 1, 0, 0, 2, 0]]) {
    assert.equal(readProductUploadReportSummary(zip([...fixture({ counts })])), null);
  }
  assert.deepEqual(readProductUploadReportSummary(zip([...fixture({ counts: [10000000, 10000000, 0, 0, 0, 0] })])).counts,
    { submitted: 10000000, success: 10000000, failed: 0, warning: 0 });
});

test('formulas, DTDs, external entities and worksheet namespace substitutions provide no evidence', () => {
  for (const file of [WORKBOOK, RELS, STRINGS, SHEET]) {
    assert.equal(readProductUploadReportSummary(changed(file, s => `<!DOCTYPE x [<!ENTITY leak SYSTEM "https://example.invalid/private">]>${s}`)), null);
    assert.equal(readProductUploadReportSummary(changed(file, s => `${s}<?unexpected instruction?>`)), null);
  }
  for (const mutate of [s => s.replace('<v>3</v>', '<f>1+2</f><v>3</v>'),
    s => s.replace('<c r="B4"', '<c xmlns:m="http://schemas.openxmlformats.org/spreadsheetml/2006/main" r="B4"').replace('<v>0</v>', '<m:f/><v>0</v>'),
    s => s.replace('<sheetData>', '<sheetData xmlns="https://example.invalid/forged">'),
    s => s.replace('<v>3</v>', '<v>&unknown;</v>')]) {
    assert.equal(readProductUploadReportSummary(changed(SHEET, mutate)), null);
  }
});

test('external, escaping and duplicate relationships are refused without fetching any target', () => {
  for (const mutate of [s => s.replace('Target="worksheets/report.xml"', 'Target="https://example.invalid/report.xml" TargetMode="External"'),
    s => s.replace('Target="worksheets/report.xml"', 'Target="../private.xml"'),
    s => s.replace('Target="worksheets/report.xml"', 'Target="/xl/worksheets/report.xml"'),
    s => s.replace('</Relationships>', `<Relationship Id="summary" Type="${R}/worksheet" Target="worksheets/report.xml"/></Relationships>`),
    s => s.replace(`${R}/worksheet`, `${R}/externalLink`)]) {
    assert.equal(readProductUploadReportSummary(changed(RELS, mutate)), null);
  }
});

test('truncated XML, mismatched tags, duplicate attributes and invalid UTF-8 fail closed', () => {
  for (const file of [WORKBOOK, RELS, STRINGS, SHEET]) for (const mutate of [s => s.slice(0, -5), s => s + '<unclosed>']) {
    assert.equal(readProductUploadReportSummary(changed(file, mutate)), null);
  }
  for (const mutate of [s => s.replace('<c r="E4"', '<c r="E4" r="E5"'),
    s => s.replace('</row>', '</wrong>'), s => s.replace('r="E4"', 'r="E4'),
    s => Buffer.concat([Buffer.from(s), Buffer.from([0xff])])]) {
    assert.equal(readProductUploadReportSummary(changed(SHEET, mutate)), null);
  }
});

test('ZIP truncation, duplicate members, traversal, encryption and checksum corruption are rejected', () => {
  const original = zip([...fixture()]);
  for (const buffer of [original.subarray(0, -1), Buffer.concat([original, Buffer.from('trailing')]),
    zip([...fixture(), [WORKBOOK, fixture().get(WORKBOOK)]]), zip([...fixture(), ['../private', 'no']]),
    zip([...fixture(), ['xl/vbaProject.bin', 'macro']]), zip([...fixture(), ['xl/externalLinks/externalLink1.xml', 'external']])]) {
    assert.equal(readProductUploadReportSummary(buffer), null);
  }
  const offset = original.readUInt32LE(original.length - 22 + 16);
  for (const mutate of [b => b.writeUInt16LE(1, 6), b => b.writeUInt32LE(123, 14),
    b => b.writeUInt32LE(123, offset + 16), b => { b[30] ^= 1; }, b => b.writeUInt16LE(99, offset + 10)]) {
    const buffer = Buffer.from(original); mutate(buffer); assert.equal(readProductUploadReportSummary(buffer), null);
  }
});

test('bounded ZIP/XML limits reject oversized input and declared expansion without allocating the declared output', () => {
  assert.equal(readProductUploadReportSummary(Buffer.alloc(20 * 1024 * 1024 + 1)), null);
  const entries = [...fixture()];
  assert.equal(readProductUploadReportSummary(zip([...entries, ...Array.from({ length: 513 }, (_, i) => [`extra/${i}`, ''])])), null);
  const buffer = zip(entries), offset = buffer.readUInt32LE(buffer.length - 6);
  buffer.writeUInt32LE(101 * 1024 * 1024, offset + 24);
  assert.equal(readProductUploadReportSummary(buffer), null);
  const deep = '<x>'.repeat(65) + '</x>'.repeat(65);
  assert.equal(readProductUploadReportSummary(changed(SHEET, s => s.replace('<sheetData>', `<sheetData>${deep}`))), null);
});
