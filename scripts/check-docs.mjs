import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];
function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(file);
  }
}
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.md')) files.push(path.join(root, entry.name));
}
collect(path.join(root, 'docs'));
collect(path.join(root, '.github'));

function withoutFences(text) {
  let fence = null;
  return text.split('\n').map(line => {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match) {
      if (!fence) fence = match[1];
      else if (match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
      return '';
    }
    return fence ? '' : line;
  }).join('\n');
}
function headings(text) {
  const counts = new Map();
  return [...text.matchAll(/^(#{1,6})\s+(.+)$/gm)].map(match => {
    const title = match[2].replace(/\s+#+\s*$/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    const base = title.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\p{Pc}\-\s]/gu, '').replace(/\s/g, '-');
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    return { level: match[1].length, id: base + (count ? `-${count}` : '') };
  });
}
const pages = new Map(files.map(file => {
  const text = withoutFences(fs.readFileSync(file, 'utf8'));
  return [file, { text, headings: headings(text) }];
}));
const errors = [];
let links = 0;
for (const [file, page] of pages) {
  const name = path.relative(root, file);
  if (page.headings.filter(h => h.level === 1).length !== 1) errors.push(`${name}: 必须有且仅有一个一级标题`);
  let previous = 0;
  for (const heading of page.headings) {
    if (heading.level > previous + 1) errors.push(`${name}: 标题层级跳跃至 ${heading.id}`);
    previous = heading.level;
  }
  for (const match of page.text.matchAll(/\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1].replace(/^<|>$/g, '');
    if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith('//')) continue;
    links++;
    const [rawPath, rawAnchor] = target.split('#', 2);
    let targetFile, anchor;
    try {
      targetFile = rawPath ? path.resolve(path.dirname(file), decodeURIComponent(rawPath)) : file;
      anchor = rawAnchor ? decodeURIComponent(rawAnchor) : '';
    } catch {
      errors.push(`${name}: 无效链接编码 ${target}`); continue;
    }
    if (path.relative(root, targetFile).startsWith('..') || !fs.existsSync(targetFile)) {
      errors.push(`${name}: 目标不存在或位于仓库外 ${target}`); continue;
    }
    if (anchor && pages.has(targetFile) && !pages.get(targetFile).headings.some(h => h.id === anchor)) {
      errors.push(`${name}: 标题锚点不存在 ${target}`);
    }
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else console.log(`文档检查通过：${files.length} 篇 Markdown，${links} 个本地链接。`);
