import { execFileSync } from 'node:child_process';

export const ZINIAO_KEYCHAIN_SERVICE = 'com.singal.amzguard.ziniao';
export const DINGTALK_KEYCHAIN_SERVICE = 'com.singal.amzguard.dingtalk';
export const CRM_KEYCHAIN_SERVICE = 'com.singal.amzguard.crm';
export const ALERT_WEBHOOK_KEYCHAIN_SERVICE = 'com.singal.amzguard.alert-webhook';
export const DASHBOARD_KEYCHAIN_SERVICE = 'com.singal.amzguard.dashboard';

const KEYCHAIN_ACCOUNT = 'default';

function normalizedAccount(value, fallback = KEYCHAIN_ACCOUNT) {
  const account = String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return account || fallback;
}

function ziniaoComplete(value) {
  return Boolean(value?.company && value?.username && value?.password);
}

function cleanObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function decodeKeychainPayload(rawValue) {
  let raw = Buffer.isBuffer(rawValue) ? rawValue.toString('utf8') : String(rawValue || '');
  raw = raw.trim();
  // `security -w` prints non-ASCII generic passwords as bare hex on some
  // macOS versions. Decode only when the complete output has that form.
  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) raw = Buffer.from(raw, 'hex').toString('utf8');
  return cleanObject(JSON.parse(raw));
}

function readKeychain(service, { platform = process.platform, exec = execFileSync, account = KEYCHAIN_ACCOUNT } = {}) {
  if (platform !== 'darwin') return null;
  try {
    return decodeKeychainPayload(exec('security', [
      'find-generic-password', '-s', service, '-a', account, '-w',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
}

function saveKeychain(service, value, { platform = process.platform, exec = execFileSync, account = KEYCHAIN_ACCOUNT } = {}) {
  if (platform !== 'darwin') throw new Error('安全凭据存储当前仅支持 macOS Keychain；其他系统请使用受保护的环境变量');
  const payloadHex = Buffer.from(JSON.stringify(value), 'utf8').toString('hex');
  // Apple explicitly marks `-w password` as insecure because it exposes the
  // secret in argv. Its prompt reads /dev/tty rather than a pipe, so use the
  // interactive command stream and -X hex data: argv/process listings remain
  // secret-free, while stdout is discarded to avoid an interactive echo.
  const command = `add-generic-password -U -s ${service} -a ${account} -X ${payloadHex}\n`;
  exec('security', ['-i'], {
    input: command,
    encoding: 'utf8',
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

function deleteKeychain(service, { platform = process.platform, exec = execFileSync, account = KEYCHAIN_ACCOUNT } = {}) {
  if (platform !== 'darwin') return false;
  try {
    exec('security', [
      'delete-generic-password', '-s', service, '-a', account,
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function sourceLabel(usedEnv, usedKeychain) {
  if (usedEnv && usedKeychain) return 'environment + macOS Keychain';
  if (usedEnv) return 'environment';
  if (usedKeychain) return 'macOS Keychain';
  return 'missing';
}

/**
 * Resolve credentials without ever logging their values. Environment variables
 * win; on macOS, missing fields fall back to the user's login Keychain so
 * launchd jobs work without secrets inside plist files.
 */
export function loadZiniaoCredentials({ env = process.env, platform = process.platform, exec = execFileSync } = {}) {
  const credentials = {
    company: env.ZINIAO_COMPANY || '',
    username: env.ZINIAO_USERNAME || '',
    password: env.ZINIAO_PASSWORD || '',
  };
  const usedEnv = Boolean(credentials.company || credentials.username || credentials.password);
  let usedKeychain = false;

  if (!ziniaoComplete(credentials)) {
    const stored = readKeychain(ZINIAO_KEYCHAIN_SERVICE, { platform, exec });
    if (stored) {
      credentials.company ||= String(stored.company || '');
      credentials.username ||= String(stored.username || '');
      credentials.password ||= String(stored.password || '');
      usedKeychain = true;
    }
  }

  return {
    credentials,
    source: sourceLabel(usedEnv, usedKeychain),
    complete: ziniaoComplete(credentials),
  };
}

export function saveZiniaoCredentials(credentials, options = {}) {
  if (!ziniaoComplete(credentials)) throw new Error('企业名、用户名和密码均不能为空');
  saveKeychain(ZINIAO_KEYCHAIN_SERVICE, {
    company: String(credentials.company),
    username: String(credentials.username),
    password: String(credentials.password),
  }, options);
}

export function deleteZiniaoCredentials(options = {}) {
  return deleteKeychain(ZINIAO_KEYCHAIN_SERVICE, options);
}

export function loadDingTalkCredentials({
  env = process.env,
  platform = process.platform,
  exec = execFileSync,
  channel = 'regular',
} = {}) {
  const account = normalizedAccount(channel, 'regular');
  const envName = account.replace(/[^a-z0-9]/g, '_').toUpperCase();
  const legacy = account === 'regular' || account === 'default';
  const operations = account === 'operations' || account === 'ops';
  const credentials = {
    webhook: (legacy ? env.DINGTALK_WEBHOOK : '')
      || (operations ? env.DINGTALK_OPS_WEBHOOK : '')
      || env[`DINGTALK_${envName}_WEBHOOK`] || '',
    secret: (legacy ? env.DINGTALK_SECRET : '')
      || (operations ? env.DINGTALK_OPS_SECRET : '')
      || env[`DINGTALK_${envName}_SECRET`] || '',
  };
  const usedEnv = Boolean(credentials.webhook || credentials.secret);
  let usedKeychain = false;
  if (!credentials.webhook || !credentials.secret) {
    let stored = readKeychain(DINGTALK_KEYCHAIN_SERVICE, { platform, exec, account });
    // Compatibility for credentials written before named DingTalk channels.
    if (!stored && legacy && account !== KEYCHAIN_ACCOUNT) {
      stored = readKeychain(DINGTALK_KEYCHAIN_SERVICE, { platform, exec, account: KEYCHAIN_ACCOUNT });
    }
    if (stored) {
      credentials.webhook ||= String(stored.webhook || '');
      credentials.secret ||= String(stored.secret || '');
      usedKeychain = true;
    }
  }
  return {
    credentials,
    source: sourceLabel(usedEnv, usedKeychain),
    complete: Boolean(credentials.webhook),
  };
}

export function saveDingTalkCredentials(credentials, { channel = 'regular', ...options } = {}) {
  if (!credentials?.webhook) throw new Error('钉钉 Webhook 不能为空');
  saveKeychain(DINGTALK_KEYCHAIN_SERVICE, {
    webhook: String(credentials.webhook),
    secret: String(credentials.secret || ''),
  }, { ...options, account: normalizedAccount(channel, 'regular') });
}

export function deleteDingTalkCredentials({ channel = 'regular', ...options } = {}) {
  return deleteKeychain(DINGTALK_KEYCHAIN_SERVICE, {
    ...options,
    account: normalizedAccount(channel, 'regular'),
  });
}

export function loadCrmCredentials({ env = process.env, platform = process.platform, exec = execFileSync } = {}) {
  const credentials = {
    endpoint: env.CRM_ENDPOINT || '',
    token: env.CRM_TOKEN || '',
  };
  const usedEnv = Boolean(credentials.endpoint || credentials.token);
  let usedKeychain = false;
  if (!credentials.endpoint || !credentials.token) {
    const stored = readKeychain(CRM_KEYCHAIN_SERVICE, { platform, exec });
    if (stored) {
      credentials.endpoint ||= String(stored.endpoint || '');
      credentials.token ||= String(stored.token || '');
      usedKeychain = true;
    }
  }
  return {
    credentials,
    source: sourceLabel(usedEnv, usedKeychain),
    complete: Boolean(credentials.endpoint && credentials.token),
  };
}

export function saveCrmCredentials(credentials, options = {}) {
  if (!credentials?.token) throw new Error('CRM Token 不能为空');
  saveKeychain(CRM_KEYCHAIN_SERVICE, {
    endpoint: String(credentials.endpoint || ''),
    token: String(credentials.token),
  }, options);
}

export function deleteCrmCredentials(options = {}) {
  return deleteKeychain(CRM_KEYCHAIN_SERVICE, options);
}

export function loadAlertWebhookCredentials({ env = process.env, platform = process.platform, exec = execFileSync } = {}) {
  const credentials = {
    url: env.ALERT_WEBHOOK_URL || '',
    authorization: env.ALERT_WEBHOOK_AUTHORIZATION || '',
  };
  const usedEnv = Boolean(credentials.url || credentials.authorization);
  let usedKeychain = false;
  if (!credentials.url || !credentials.authorization) {
    const stored = readKeychain(ALERT_WEBHOOK_KEYCHAIN_SERVICE, { platform, exec });
    if (stored) {
      credentials.url ||= String(stored.url || '');
      credentials.authorization ||= String(stored.authorization || '');
      usedKeychain = true;
    }
  }
  return {
    credentials,
    source: sourceLabel(usedEnv, usedKeychain),
    complete: Boolean(credentials.url),
  };
}

export function saveAlertWebhookCredentials(credentials, options = {}) {
  if (!credentials?.url) throw new Error('报警 Webhook URL 不能为空');
  saveKeychain(ALERT_WEBHOOK_KEYCHAIN_SERVICE, {
    url: String(credentials.url),
    authorization: String(credentials.authorization || ''),
  }, options);
}

export function deleteAlertWebhookCredentials(options = {}) {
  return deleteKeychain(ALERT_WEBHOOK_KEYCHAIN_SERVICE, options);
}

export function loadDashboardCredentials({ env = process.env, platform = process.platform, exec = execFileSync } = {}) {
  const credentials = {
    username: env.DASHBOARD_USERNAME || '',
    password: env.DASHBOARD_PASSWORD || '',
    sessionSecret: env.DASHBOARD_SESSION_SECRET || '',
  };
  const usedEnv = Boolean(credentials.username || credentials.password || credentials.sessionSecret);
  let usedKeychain = false;
  if (!credentials.password || !credentials.sessionSecret) {
    const stored = readKeychain(DASHBOARD_KEYCHAIN_SERVICE, { platform, exec });
    if (stored) {
      credentials.username ||= String(stored.username || '');
      credentials.password ||= String(stored.password || '');
      credentials.sessionSecret ||= String(stored.sessionSecret || '');
      usedKeychain = true;
    }
  }
  return {
    credentials,
    source: sourceLabel(usedEnv, usedKeychain),
    complete: Boolean(credentials.password && credentials.sessionSecret),
  };
}

export function saveDashboardCredentials(credentials, options = {}) {
  if (!credentials?.password || !credentials?.sessionSecret) {
    throw new Error('Dashboard 密码和 Session Secret 均不能为空');
  }
  saveKeychain(DASHBOARD_KEYCHAIN_SERVICE, {
    username: String(credentials.username || 'admin'),
    password: String(credentials.password),
    sessionSecret: String(credentials.sessionSecret),
  }, options);
}

export function deleteDashboardCredentials(options = {}) {
  return deleteKeychain(DASHBOARD_KEYCHAIN_SERVICE, options);
}
