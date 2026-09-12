import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createUserStore } from '../src/lib/users.js';

function tempOut() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'amzguard-users-'));
}

test('user store bootstraps one admin and never stores a plaintext password', () => {
  const outDir = tempOut();
  const password = 'bootstrap-password-123';
  const users = createUserStore({ outDir, bootstrapUsername: 'admin', bootstrapPassword: password });
  assert.equal(users.enabled(), true);
  assert.equal(users.verifyPassword('admin', password)?.role, 'admin');
  assert.equal(users.verifyPassword('admin', 'wrong-password'), null);
  assert.doesNotMatch(fs.readFileSync(users.file, 'utf8'), new RegExp(password));
  if (process.platform !== 'win32') assert.equal(fs.statSync(users.file).mode & 0o777, 0o600);
});

test('admins can create, reset, disable and remove users while sessions are versioned', () => {
  const users = createUserStore({ outDir: tempOut(), bootstrapUsername: 'admin', bootstrapPassword: 'bootstrap-password-123' });
  const created = users.create({ username: 'operator.one', password: 'operator-password-123', role: 'operator' });
  assert.equal(created.role, 'operator');
  assert.equal(users.verifyPassword('operator.one', 'operator-password-123')?.credentialVersion, 1);

  const reset = users.changePassword({ username: 'operator.one', newPassword: 'new-operator-password-456' });
  assert.equal(reset.credentialVersion, 2);
  assert.equal(users.verifyPassword('operator.one', 'operator-password-123'), null);
  assert.equal(users.verifyPassword('operator.one', 'new-operator-password-456')?.credentialVersion, 2);

  const disabled = users.update({ username: 'operator.one', enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(users.verifyPassword('operator.one', 'new-operator-password-456'), null);
  assert.equal(users.remove('operator.one').username, 'operator.one');
  assert.deepEqual(users.list().map((user) => user.username), ['admin']);
});

test('user creation accepts any non-empty password length and preserves admin safeguards', () => {
  const users = createUserStore({ outDir: tempOut(), bootstrapUsername: 'admin', bootstrapPassword: 'bootstrap-password-123' });
  assert.throws(() => users.create({ username: 'x', password: 'operator-password-123' }), /3-32/);
  users.create({ username: 'short.password', password: '1' });
  users.create({ username: 'long.password', password: 'x'.repeat(300) });
  assert.equal(users.verifyPassword('short.password', '1')?.role, 'operator');
  assert.ok(users.verifyPassword('long.password', 'x'.repeat(300)));
  assert.throws(() => users.create({ username: 'empty.password', password: '' }), /不能为空/);
  assert.throws(() => users.update({ username: 'admin', enabled: false }), /至少一个启用的管理员/);
  assert.throws(() => users.remove('admin'), /至少一个启用的管理员/);
  assert.equal(users.get('admin')?.enabled, true);
});

test('a damaged user database fails closed instead of falling back to bootstrap credentials', () => {
  const outDir = tempOut();
  const runtime = path.join(outDir, 'runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'users.json'), '{broken');
  assert.throws(
    () => createUserStore({ outDir, bootstrapUsername: 'admin', bootstrapPassword: 'bootstrap-password-123' }).enabled(),
    /用户库损坏/,
  );
});
