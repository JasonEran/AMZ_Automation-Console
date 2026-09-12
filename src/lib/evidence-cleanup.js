import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SECURITY_CLEANUP_FAILED = 'SECURITY_CLEANUP_FAILED';

const success = (extra = {}) => ({
  ok: true,
  code: 'CLEANED',
  removed: false,
  quarantined: false,
  ...extra,
});

const failure = (reason, extra = {}) => ({
  ok: false,
  code: SECURITY_CLEANUP_FAILED,
  reason,
  removed: false,
  quarantined: false,
  ...extra,
});

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isPlainDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

// chmod(path) follows a symlink if an in-root path is swapped after lstat.
// Open with O_NOFOLLOW and change the already-open inode instead, so cleanup
// failure handling can never chmod a file outside the evidence root.
function chmodEntryNoFollow(file, mode, expectDirectory, fsImpl) {
  const constants = fsImpl.constants || fs.constants;
  if (typeof constants.O_NOFOLLOW !== 'number') return false;
  const directoryFlag = expectDirectory && typeof constants.O_DIRECTORY === 'number'
    ? constants.O_DIRECTORY
    : 0;
  let fd = null;
  try {
    fd = fsImpl.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | directoryFlag);
    const stat = fsImpl.fstatSync(fd);
    if (expectDirectory ? !stat.isDirectory() : !stat.isFile()) return false;
    fsImpl.fchmodSync(fd, mode);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fsImpl.closeSync(fd); } catch { /* fail closed through the caller's result */ }
    }
  }
}

function validateRoot(outDir, fsImpl) {
  if (!outDir || typeof outDir !== 'string') return null;
  const lexicalRoot = path.resolve(outDir);
  try {
    const stat = fsImpl.lstatSync(lexicalRoot);
    if (!isPlainDirectory(stat)) return null;
    return { lexicalRoot, realRoot: fsImpl.realpathSync(lexicalRoot) };
  } catch {
    return null;
  }
}

function validateExistingFile(file, root, fsImpl) {
  if (!file || typeof file !== 'string') return { ok: false, reason: 'INVALID_TARGET' };
  const lexicalFile = path.resolve(file);
  if (!isInside(root.lexicalRoot, lexicalFile)) return { ok: false, reason: 'OUTSIDE_ROOT' };
  let stat;
  try {
    stat = fsImpl.lstatSync(lexicalFile);
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, missing: true, lexicalFile };
    return { ok: false, reason: 'TARGET_INSPECTION_FAILED' };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, reason: 'UNSAFE_TARGET_TYPE' };
  try {
    const realParent = fsImpl.realpathSync(path.dirname(lexicalFile));
    const realFile = fsImpl.realpathSync(lexicalFile);
    if (!isInside(root.realRoot, realParent) && realParent !== root.realRoot) {
      return { ok: false, reason: 'OUTSIDE_ROOT' };
    }
    if (!isInside(root.realRoot, realFile)) return { ok: false, reason: 'OUTSIDE_ROOT' };
  } catch {
    return { ok: false, reason: 'TARGET_INSPECTION_FAILED' };
  }
  return { ok: true, missing: false, lexicalFile };
}

function prepareQuarantine(root, fsImpl) {
  const quarantine = path.join(root.lexicalRoot, '.evidence-quarantine');
  try {
    fsImpl.mkdirSync(quarantine, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') return null;
  }
  try {
    const stat = fsImpl.lstatSync(quarantine);
    if (!isPlainDirectory(stat)) return null;
    const realQuarantine = fsImpl.realpathSync(quarantine);
    if (!isInside(root.realRoot, realQuarantine)) return null;
    if (!chmodEntryNoFollow(quarantine, 0o700, true, fsImpl)) return null;
    return quarantine;
  } catch {
    return null;
  }
}

/**
 * Remove one screenshot or other sensitive evidence artifact without following
 * symlinks or escaping the configured output root. A failed unlink is isolated
 * under a mode-0700 quarantine and the quarantined file is mode 000. Isolation
 * is deliberately still reported as failure so callers cannot claim cleanup
 * succeeded when the bytes remain on disk.
 *
 * The result intentionally contains no filesystem path or basename.
 */
export function secureCleanupEvidence({ file, outDir, fsImpl = fs, randomBytes = crypto.randomBytes }) {
  if (!file) return success({ code: 'NOT_PRESENT' });
  const root = validateRoot(outDir, fsImpl);
  if (!root) return failure('INVALID_ROOT');
  let checked = validateExistingFile(file, root, fsImpl);
  if (!checked.ok) return failure(checked.reason);
  if (checked.missing) return success({ code: 'NOT_PRESENT' });

  try {
    fsImpl.unlinkSync(checked.lexicalFile);
    return success({ removed: true });
  } catch {
    // Re-check after the failed operation. Never rename a target that changed
    // into a symlink, directory, or path outside the trusted output root.
    checked = validateExistingFile(checked.lexicalFile, root, fsImpl);
    if (!checked.ok) return failure(checked.reason);
    if (checked.missing) return success({ code: 'NOT_PRESENT' });
    const quarantine = prepareQuarantine(root, fsImpl);
    if (!quarantine) return failure('QUARANTINE_UNAVAILABLE');
    let token;
    try {
      token = randomBytes(16).toString('hex');
    } catch {
      return failure('QUARANTINE_NAME_FAILED');
    }
    const destination = path.join(quarantine, `evidence-${token}.blocked`);
    try {
      fsImpl.renameSync(checked.lexicalFile, destination);
    } catch {
      return failure('QUARANTINE_MOVE_FAILED');
    }
    if (!chmodEntryNoFollow(destination, 0o000, false, fsImpl)) {
      return failure('QUARANTINE_LOCKDOWN_FAILED');
    }
    return failure('UNLINK_FAILED', { quarantined: true });
  }
}

/** Confirm that an evidence artifact is a real in-root file before retaining it. */
export function validateEvidenceArtifact({ file, outDir, fsImpl = fs }) {
  const root = validateRoot(outDir, fsImpl);
  if (!root) return failure('INVALID_ROOT');
  const checked = validateExistingFile(file, root, fsImpl);
  if (!checked.ok) return failure(checked.reason);
  if (checked.missing) return failure('TARGET_NOT_FOUND');
  return success({ code: 'TRUSTED_EVIDENCE_ARTIFACT' });
}

/**
 * Clean the caller-authorized screenshot target after an untrusted transport
 * result. The transport-reported path is compared but never deleted: allowing
 * it to nominate an arbitrary in-root file would turn cleanup into a deletion
 * primitive. A missing or mismatched reported path therefore fails closed.
 */
export function secureCleanupReportedEvidence({
  expectedFile, reportedFile, outDir, fsImpl = fs, randomBytes = crypto.randomBytes,
}) {
  const cleaned = secureCleanupEvidence({
    file: expectedFile, outDir, fsImpl, randomBytes,
  });
  if (!cleaned.ok) return cleaned;
  if (!reportedFile || typeof reportedFile !== 'string') {
    return failure('UNTRUSTED_REPORTED_TARGET');
  }
  let matches = false;
  try {
    matches = path.resolve(reportedFile) === path.resolve(expectedFile);
  } catch {
    matches = false;
  }
  return matches ? cleaned : failure('UNTRUSTED_REPORTED_TARGET');
}

/** Clean a de-duplicated set of paths and retain the most severe outcome. */
export function secureCleanupEvidenceSet({ files, outDir, fsImpl = fs, randomBytes = crypto.randomBytes }) {
  const unique = [];
  const seen = new Set();
  for (const file of files || []) {
    if (!file || typeof file !== 'string') continue;
    const key = path.resolve(file);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(file);
  }
  let aggregate = success({ code: 'NOT_PRESENT' });
  let firstFailure = null;
  for (const file of unique) {
    const result = secureCleanupEvidence({ file, outDir, fsImpl, randomBytes });
    if (!result.ok) {
      firstFailure ||= result;
      continue;
    }
    if (result.removed) aggregate = result;
  }
  return firstFailure || aggregate;
}

/** Build a fail-closed safety record without including an artifact path. */
export function cleanupFailureSafety(previous = null) {
  return {
    safe: false,
    code: SECURITY_CLEANUP_FAILED,
    authSensitive: false,
    blocked: false,
    emptyShell: false,
    cleanupFailed: true,
    currentUrl: previous?.currentUrl ?? null,
  };
}
