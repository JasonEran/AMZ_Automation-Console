import fs from 'node:fs';
import path from 'node:path';
import { PRODUCT_UPLOAD_STATES } from './product-upload.js';

const safeStates = new Set(['COMPLETED', 'REJECTED', 'FAILED_BEFORE_SUBMIT', 'EXPIRED']);
const blocked = (code, message) => Object.assign(new Error(message), { status: 409, code });

/** Inspect only ledger metadata; never expire jobs, touch payloads or recover runs.
 * Caller holds the shared run lease before checking and changing a binding.
 */
export function assertStoreUploadBindingIdle({ outDir, storeKey }) {
  const root = path.resolve(outDir), uploads = path.join(root, 'product-uploads'), jobs = path.join(uploads, 'jobs');
  try {
    for (const dir of [root, uploads, jobs]) {
      let stat;
      try { stat = fs.lstatSync(dir); }
      catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('directory');
    }
    for (const entry of fs.readdirSync(jobs, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^upl_[a-f0-9]{32}$/.test(entry.name)) throw new Error('entry');
      const file = path.join(jobs, entry.name, 'record.json');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      let job;
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('file');
        const bytes = fs.readFileSync(fd);
        if (bytes.length > 1024 * 1024) throw new Error('size');
        job = JSON.parse(bytes.toString('utf8'));
      } finally { fs.closeSync(fd); }
      if (job?.version !== 1 || job.id !== entry.name || !PRODUCT_UPLOAD_STATES.includes(job.state)
          || typeof job.store?.key !== 'string' || !job.store.key) throw new Error('schema');
      if (job.store.key === storeKey && !safeStates.has(job.state)) {
        throw blocked('STORE_UPLOAD_PENDING', '店铺存在未完成或结果未知的上传任务，暂不能修改绑定或停用；可修改展示名称');
      }
    }
  } catch (cause) {
    if (cause.code === 'STORE_UPLOAD_PENDING') throw cause;
    throw blocked('STORE_UPLOAD_EVIDENCE_INVALID', '上传任务账本无法完整核对，暂不能修改店铺绑定或停用');
  }
}
