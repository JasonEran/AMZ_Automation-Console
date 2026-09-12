import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const PASSWORD_MIN_LENGTH = 12;
const ROLES = new Set(['admin', 'operator']);
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* non-POSIX */ }
}

function atomicJson(file, value) {
  privateDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
}

function validateUsername(username) {
  const value = String(username || '').trim();
  if (!USERNAME_RE.test(value)) throw new Error('用户名须为 3-32 位字母、数字、点、下划线或连字符');
  return value;
}

function validatePassword(password, { unrestrictedLength = false } = {}) {
  const value = String(password || '');
  if (!value) throw new Error('密码不能为空');
  if (unrestrictedLength) return value;
  if (value.length < PASSWORD_MIN_LENGTH || value.length > 256) {
    throw new Error(`密码须为 ${PASSWORD_MIN_LENGTH}-256 个字符`);
  }
  return value;
}

function validateRole(role) {
  const value = String(role || 'operator').toLowerCase();
  if (!ROLES.has(value)) throw new Error('角色只允许 admin 或 operator');
  return value;
}

function passwordRecord(password, options) {
  const value = validatePassword(password, options);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(value, salt, 32, SCRYPT_OPTIONS);
  return { salt: salt.toString('base64url'), passwordHash: hash.toString('base64url') };
}

function publicUser(user) {
  return {
    username: user.username,
    role: user.role,
    enabled: user.enabled !== false,
    credentialVersion: Number(user.credentialVersion || 1),
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
  };
}

export function createUserStore({ outDir, bootstrapUsername = 'admin', bootstrapPassword = '' }) {
  const file = path.join(path.resolve(outDir), 'runtime', 'users.json');

  const read = () => {
    if (!fs.existsSync(file)) return { version: 1, users: [] };
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { throw new Error(`用户库损坏，拒绝降级认证: ${error.message}`); }
    if (parsed?.version !== 1 || !Array.isArray(parsed.users)) throw new Error('用户库格式无效，拒绝降级认证');
    for (const user of parsed.users) {
      if (!USERNAME_RE.test(String(user?.username || '')) || !ROLES.has(user?.role)
        || typeof user?.salt !== 'string' || typeof user?.passwordHash !== 'string') {
        throw new Error('用户库包含无效账户记录，拒绝降级认证');
      }
    }
    return parsed;
  };

  const write = (data) => atomicJson(file, data);
  if (!fs.existsSync(file) && bootstrapPassword) {
    const now = new Date().toISOString();
    write({
      version: 1,
      users: [{
        username: validateUsername(bootstrapUsername), role: 'admin', enabled: true,
        credentialVersion: 1, ...passwordRecord(bootstrapPassword), createdAt: now, updatedAt: now,
      }],
    });
  }

  const get = (username) => read().users.find((user) => user.username === String(username || '')) || null;
  const verifyPassword = (username, password) => {
    const user = get(username);
    const salt = user?.salt || Buffer.alloc(16).toString('base64url');
    const expected = user?.passwordHash || Buffer.alloc(32).toString('base64url');
    let actual;
    try {
      actual = crypto.scryptSync(String(password || ''), Buffer.from(salt, 'base64url'), 32, SCRYPT_OPTIONS);
    } catch { actual = Buffer.alloc(32); }
    const expectedBuffer = Buffer.from(expected, 'base64url');
    const valid = expectedBuffer.length === actual.length && crypto.timingSafeEqual(expectedBuffer, actual);
    return valid && user?.enabled !== false ? publicUser(user) : null;
  };

  const mutate = (fn) => {
    const data = read();
    const result = fn(data);
    write(data);
    return result;
  };

  return {
    file,
    enabled: () => read().users.length > 0,
    list: () => read().users.map(publicUser).sort((a, b) => a.username.localeCompare(b.username)),
    get: (username) => {
      const user = get(username);
      return user ? publicUser(user) : null;
    },
    verifyPassword,
    create({ username, password, role = 'operator' }) {
      return mutate((data) => {
        const name = validateUsername(username);
        if (data.users.some((user) => user.username.toLowerCase() === name.toLowerCase())) {
          throw new Error('用户名已存在');
        }
        const now = new Date().toISOString();
        const user = {
          username: name, role: validateRole(role), enabled: true, credentialVersion: 1,
          ...passwordRecord(password, { unrestrictedLength: true }), createdAt: now, updatedAt: now,
        };
        data.users.push(user);
        return publicUser(user);
      });
    },
    changePassword({ username, newPassword }) {
      return mutate((data) => {
        const user = data.users.find((candidate) => candidate.username === String(username || ''));
        if (!user) throw new Error('用户不存在');
        Object.assign(user, passwordRecord(newPassword));
        user.credentialVersion = Number(user.credentialVersion || 1) + 1;
        user.updatedAt = new Date().toISOString();
        return publicUser(user);
      });
    },
    update({ username, enabled, role }) {
      return mutate((data) => {
        const user = data.users.find((candidate) => candidate.username === String(username || ''));
        if (!user) throw new Error('用户不存在');
        if (enabled !== undefined) user.enabled = Boolean(enabled);
        if (role !== undefined) user.role = validateRole(role);
        const enabledAdmins = data.users.filter((candidate) => candidate.enabled !== false && candidate.role === 'admin');
        if (!enabledAdmins.length) throw new Error('系统必须保留至少一个启用的管理员');
        user.credentialVersion = Number(user.credentialVersion || 1) + 1;
        user.updatedAt = new Date().toISOString();
        return publicUser(user);
      });
    },
    remove(username) {
      return mutate((data) => {
        const index = data.users.findIndex((candidate) => candidate.username === String(username || ''));
        if (index < 0) throw new Error('用户不存在');
        const [removed] = data.users.splice(index, 1);
        if (!data.users.some((candidate) => candidate.enabled !== false && candidate.role === 'admin')) {
          throw new Error('系统必须保留至少一个启用的管理员');
        }
        return publicUser(removed);
      });
    },
  };
}

export { PASSWORD_MIN_LENGTH, USERNAME_RE };
