#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inlineSecretPaths } from '../src/lib/config.js';
import {
  loadAlertWebhookCredentials,
  loadCrmCredentials,
  loadDashboardCredentials,
  loadDingTalkCredentials,
  loadZiniaoCredentials,
  saveAlertWebhookCredentials,
  saveCrmCredentials,
  saveDashboardCredentials,
  saveDingTalkCredentials,
  saveZiniaoCredentials,
} from '../src/lib/credentials.js';
import { redactText } from '../src/lib/redact.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.resolve(SCRIPT_DIR, '..', 'config', 'config.json');

function get(object, keys) {
  let cursor = object;
  for (const key of keys) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function blank(object, keys) {
  let cursor = object;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cursor || typeof cursor !== 'object') return;
    cursor = cursor[keys[i]];
  }
  if (cursor && Object.hasOwn(cursor, keys.at(-1))) cursor[keys.at(-1)] = '';
}

function planMigration(original) {
  const config = structuredClone(original);
  const plans = [];

  const zRoot = get(config, ['ziniao', 'webdriver']) || get(config, ['ziniao']) || {};
  const ziniao = {
    company: String(zRoot.company || ''),
    username: String(zRoot.username || ''),
    password: String(zRoot.password || ''),
  };
  if (ziniao.company || ziniao.username || ziniao.password) {
    if (!ziniao.company || !ziniao.username || !ziniao.password) {
      throw new Error('紫鸟内联凭据不完整，未执行迁移');
    }
    plans.push({
      kind: 'ziniao',
      save: () => saveZiniaoCredentials(ziniao),
      verify: () => {
        const loaded = loadZiniaoCredentials({ env: {} });
        return loaded.complete && Object.keys(ziniao).every((key) => loaded.credentials[key] === ziniao[key]);
      },
    });
    for (const key of ['company', 'username', 'password']) {
      blank(config, ['ziniao', 'webdriver', key]);
      blank(config, ['ziniao', key]);
    }
  }

  const dingtalk = {
    webhook: String(get(config, ['alert', 'dingtalk', 'webhook']) || ''),
    secret: String(get(config, ['alert', 'dingtalk', 'secret']) || ''),
  };
  if (dingtalk.webhook || dingtalk.secret) {
    if (!dingtalk.webhook) throw new Error('钉钉内联凭据不完整，未执行迁移');
    plans.push({
      kind: 'dingtalk:regular',
      save: () => saveDingTalkCredentials(dingtalk, { channel: 'regular' }),
      verify: () => {
        const loaded = loadDingTalkCredentials({ env: {}, channel: 'regular' });
        return loaded.complete && loaded.credentials.webhook === dingtalk.webhook
          && loaded.credentials.secret === dingtalk.secret;
      },
    });
    blank(config, ['alert', 'dingtalk', 'webhook']);
    blank(config, ['alert', 'dingtalk', 'secret']);
  }

  const namedChannels = get(config, ['alert', 'dingtalk', 'channels']);
  const plannedChannelNames = new Set(plans.filter((item) => item.kind.startsWith('dingtalk:')).map((item) => item.kind.slice(9)));
  if (Array.isArray(namedChannels)) {
    for (let index = 0; index < namedChannels.length; index++) {
      const channel = namedChannels[index] || {};
      const name = String(channel.name || `channel-${index + 1}`).trim().toLowerCase();
      const credentials = {
        webhook: String(channel.webhook || ''),
        secret: String(channel.secret || ''),
      };
      if (!credentials.webhook && !credentials.secret) continue;
      if (!credentials.webhook) throw new Error('命名钉钉通道凭据不完整，未执行迁移');
      if (plannedChannelNames.has(name)) throw new Error('同名钉钉通道同时存在两组内联凭据，未执行迁移');
      plannedChannelNames.add(name);
      plans.push({
        kind: `dingtalk:${name}`,
        save: () => saveDingTalkCredentials(credentials, { channel: name }),
        verify: () => {
          const loaded = loadDingTalkCredentials({ env: {}, channel: name });
          return loaded.complete && loaded.credentials.webhook === credentials.webhook
            && loaded.credentials.secret === credentials.secret;
        },
      });
      blank(config, ['alert', 'dingtalk', 'channels', index, 'webhook']);
      blank(config, ['alert', 'dingtalk', 'channels', index, 'secret']);
    }
  }

  const crmAuthorization = String(get(config, ['crm', 'headers', 'Authorization']) || '');
  const crmDirectToken = String(get(config, ['crm', 'token']) || '');
  let crmToken = crmDirectToken;
  if (!crmToken && crmAuthorization) {
    const match = crmAuthorization.match(/^Bearer\s+(.+)$/i);
    if (!match) throw new Error('CRM Authorization 不是可安全迁移的 Bearer Token，未执行迁移');
    crmToken = match[1];
  }
  const crmEndpoint = String(get(config, ['crm', 'endpoint']) || '');
  let privateCrmEndpoint = false;
  try {
    const parsed = new URL(crmEndpoint);
    privateCrmEndpoint = Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
  } catch { /* an empty/non-URL endpoint is handled by normal config validation */ }
  if (crmToken || privateCrmEndpoint) {
    if (!crmToken) throw new Error('CRM URL 含认证参数但缺少可迁移 Token，未执行迁移');
    const credentials = { endpoint: crmEndpoint, token: crmToken };
    plans.push({
      kind: 'crm',
      save: () => saveCrmCredentials(credentials),
      verify: () => {
        const loaded = loadCrmCredentials({ env: {} });
        return loaded.credentials.endpoint === credentials.endpoint && loaded.credentials.token === credentials.token;
      },
    });
    blank(config, ['crm', 'token']);
    blank(config, ['crm', 'headers', 'Authorization']);
    if (privateCrmEndpoint) blank(config, ['crm', 'endpoint']);
  }

  const genericWebhook = {
    url: String(get(config, ['alert', 'webhook', 'url']) || ''),
    authorization: String(get(config, ['alert', 'webhook', 'headers', 'Authorization']) || ''),
  };
  if (genericWebhook.url || genericWebhook.authorization) {
    if (!genericWebhook.url) throw new Error('报警 Webhook 内联凭据不完整，未执行迁移');
    plans.push({
      kind: 'alert-webhook',
      save: () => saveAlertWebhookCredentials(genericWebhook),
      verify: () => {
        const loaded = loadAlertWebhookCredentials({ env: {} });
        return loaded.credentials.url === genericWebhook.url
          && loaded.credentials.authorization === genericWebhook.authorization;
      },
    });
    blank(config, ['alert', 'webhook', 'url']);
    blank(config, ['alert', 'webhook', 'headers', 'Authorization']);
  }

  const dashboard = {
    username: String(get(config, ['dashboard', 'username']) || 'admin'),
    password: String(get(config, ['dashboard', 'password']) || ''),
    sessionSecret: String(get(config, ['dashboard', 'sessionSecret']) || ''),
  };
  if (dashboard.password || dashboard.sessionSecret) {
    if (!dashboard.password || !dashboard.sessionSecret) throw new Error('Dashboard 内联凭据不完整，未执行迁移');
    plans.push({
      kind: 'dashboard',
      save: () => saveDashboardCredentials(dashboard),
      verify: () => {
        const loaded = loadDashboardCredentials({ env: {} });
        return loaded.credentials.username === dashboard.username
          && loaded.credentials.password === dashboard.password
          && loaded.credentials.sessionSecret === dashboard.sessionSecret;
      },
    });
    blank(config, ['dashboard', 'password']);
    blank(config, ['dashboard', 'sessionSecret']);
  }

  const remaining = inlineSecretPaths(config);
  if (remaining.length) {
    throw new Error(`仍有 ${remaining.length} 个无法自动迁移的凭据字段，未执行迁移`);
  }
  return { config, plans };
}

function atomicWriteJson(file, value, stat) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx', stat.mode & 0o777);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
    fs.chmodSync(file, stat.mode & 0o777);
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
}

let apply = false;
let configFile = DEFAULT_CONFIG;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--apply') apply = true;
  else if (process.argv[i] === '--config') configFile = path.resolve(process.argv[++i] || '');
  else if (process.argv[i] === '--help' || process.argv[i] === '-h') {
    process.stdout.write('node scripts/migrate-config-secrets.mjs [--config <file>] [--apply]\n');
    process.exit(0);
  } else {
    process.stderr.write('迁移未执行: 未知参数\n');
    process.exit(2);
  }
}

try {
  const stat = fs.statSync(configFile);
  if (!stat.isFile()) throw new Error('配置路径不是文件');
  const original = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const migration = planMigration(original);
  if (!migration.plans.length) {
    process.stdout.write('凭据迁移: 未发现支持的内联凭据；未输出任何字段值。\n');
    process.exit(0);
  }
  if (!apply) {
    process.stdout.write(`凭据迁移 dry-run: 可迁移 ${migration.plans.length} 组；未写 Keychain/配置，未输出任何字段值。\n`);
    process.exit(0);
  }
  if (process.platform !== 'darwin') {
    throw new Error('非 macOS 主机请把凭据写入 root:root 0600 EnvironmentFile，再手工清空配置字段');
  }
  for (const item of migration.plans) item.save();
  if (!migration.plans.every((item) => item.verify())) {
    throw new Error('Keychain 写入后验证失败，原配置保持不变');
  }
  atomicWriteJson(configFile, migration.config, stat);
  process.stdout.write(`凭据迁移完成: ${migration.plans.length} 组已进入 macOS Keychain，配置已原子清理；未输出任何字段值。\n`);
} catch (error) {
  process.stderr.write(`迁移未执行: ${redactText(error.message)}\n`);
  process.exit(2);
}
