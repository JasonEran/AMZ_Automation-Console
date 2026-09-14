import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {
  loadAlertWebhookCredentials,
  loadCrmCredentials,
  loadDingTalkCredentials,
} from './credentials.js';
import { readAdsRules } from './ads-rules.js';
import { readStoreRegistry } from './store-registry.js';

export const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');

function defaultWebDriverClientPath() {
  if (process.platform === 'darwin') return '/Applications/ziniao.app';
  if (process.platform === 'linux') return '/opt/ziniao/ziniaobrowser';
  return '';
}

export const DEFAULTS = {
  ziniao: {
    mode: 'webdriver',
    bin: 'ziniao-cli',
    openTimeoutMs: 180000,
    visitTimeoutMs: 60000,
    execTimeoutMs: 45000,
    contentTimeoutMs: 45000,
    waitUntil: 'networkidle',
    settleMs: 4000,
    headless: false,
    closeStoreAfterCheck: true,
    keepOpenOnFailure: false,
    concurrency: 1,
    staggerMs: 0,
    jitterMs: 0,
    retries: 2,
    retryDelayMs: 8000,
    webdriver: {
      clientPath: defaultWebDriverClientPath(),
      socketPort: 18888,
      autoStart: true,
      startTimeoutMs: 60000,
      httpTimeoutMs: 120000,
      coreTimeoutMs: 600000,
      corePollMs: 2000,
      pageLoadTimeoutMs: 120000,
      // Amazon pages can keep DOMContentLoaded blocked on analytics and
      // recommendation assets even after the business DOM is usable. Let each
      // check's explicit readiness loop and DOM+text gate decide completion.
      pageLoadStrategy: 'none',
      driverPath: '',
      windowRatio: 100,
      preferBrowserOauth: true,
      // Follow the official demo: open the platform launcher before a deep
      // business URL so the Ziniao profile can restore its platform session.
      openLauncherPageBeforeTarget: true,
      launcherSettleMs: 2000,
      // Amazon login recovery uses only Ziniao-filled fields and its Passkey
      // dialog; the collector never stores or types marketplace credentials.
      autoLoginAmazon: true,
      amazonLoginTimeoutMs: 90000,
      passkeyDialogXRatio: 0.5,
      passkeyDialogYRatio: 0.613,
    },
  },
  storeHealth: {
    paths: ['/performance/dashboard', '/performance/dashboard?ref=ah_home'],
    defaultHost: 'sellercentral.amazon.com',
    screenshot: true,
    fullPageScreenshot: true,
    saveRawPageText: true,
    alertOnAhrDrop: true,
    ahrDropThreshold: 1,
    alertOnStatusChange: true,
  },
  asinHealth: {
    sessionMaxItems: 10,
    // Keep item 5 current without a second hand-maintained product list: every
    // successful VOC report contributes the ASINs visible for that store.
    autoDiscoverFromVoc: true,
    settleMs: 3000,
    visitTimeoutMs: 60000,
    recheckDays: 7,
  },
  codex: {
    // Off by default: measured on a real run, `codex exec` took >2 min per call
    // and still returned nothing parseable, so it added ~8 min to a 7-store run
    // for zero signal. A deterministic UNKNOWN + alert is the better outcome.
    // Set true (and raise timeoutMs) only if it proves fast in your environment.
    enabled: false,
    bin: 'codex',
    model: '',
    timeoutMs: 120000,
    sandbox: 'read-only',
    maxPageTextChars: 8000,
    redact: true,
  },
  alert: {
    console: true,
    file: true,
    dingtalk: { enabled: false, webhook: '', secret: '', channels: [], atMobiles: [], atAll: false },
    webhook: { enabled: false, url: '', method: 'POST', headers: {} },
  },
  crm: {
    enabled: false,
    endpoint: '',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeoutMs: 30000,
    retries: 2,
  },
  productUpload: {
    results: {
      enabled: true,
      intervalMinutes: 5,
      maxAgeHours: 72,
      timeoutMs: 120000,
    },
  },
  schedule: {
    timezone: 'Asia/Shanghai',
    slots: [
      { name: 'am', at: '08:00' },
      { name: 'ads-off', at: '11:20' },
      { name: 'pm', at: '15:30' },
      { name: 'ads-on', at: '18:30' },
    ],
  },
  paths: { outDir: 'out' },
  logLevel: 'info',
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (k.startsWith('_')) continue; // drop `_comment` keys
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} 不是合法 JSON: ${e.message}`);
  }
}

function hasValue(value) {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function urlContainsPrivateParts(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
  } catch {
    // A malformed endpoint cannot be proven free of userinfo/query/fragment
    // credentials. Configuration files fail closed; protected environment
    // values are validated by their channel before any request is sent.
    return true;
  }
}

/** Return forbidden credential locations without ever returning their values. */
export function inlineSecretPaths(fileConfig) {
  const hits = [];
  const walk = (value, parts = []) => {
    if (Array.isArray(value)) {
      value.forEach((child, index) => walk(child, [...parts, String(index)]));
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('_')) continue;
      const next = [...parts, key];
      const joined = next.join('.');
      const lower = key.toLowerCase().replace(/[-_]/g, '');
      const underZiniao = parts[0] === 'ziniao';
      const webhookUrl = joined === 'alert.dingtalk.webhook' || joined === 'alert.webhook.url';
      const sensitiveHeader = (joined.startsWith('alert.webhook.headers.') || joined.startsWith('crm.headers.'))
        && !['content-type', 'accept', 'user-agent'].includes(key.toLowerCase());
      const namedSecret = !isPlainObject(child) && !Array.isArray(child)
        && /^(?:apikey|authorization|bearer|browseroauth|clientsecret|cookie|credential|dashboardpassword|idtoken|otp|password|refreshtoken|secret|sessionsecret|signature|sso|token|verificationcode|webhook)$/.test(lower);
      const ziniaoIdentity = underZiniao && /^(?:company|username)$/.test(lower);
      const endpointWithPrivateParts = (joined === 'crm.endpoint' || webhookUrl) && urlContainsPrivateParts(child);
      if (hasValue(child) && (webhookUrl || sensitiveHeader || namedSecret || ziniaoIdentity || endpointWithPrivateParts)) {
        hits.push(joined);
        continue;
      }
      walk(child, next);
    }
  };
  walk(fileConfig);
  return hits;
}

export function assertNoInlineSecrets(fileConfig, filePath = 'config.json') {
  const paths = inlineSecretPaths(fileConfig);
  if (!paths.length) return;
  throw new Error(
    `${filePath} 含禁止落盘的凭据字段：${paths.join(', ')}。`
    + '请迁移到环境变量、受保护的 EnvironmentFile 或 macOS Keychain；字段值未读取到日志。',
  );
}

/** Protected environment/Keychain overrides; secret values never come from JSON. */
function applyEnv(cfg) {
  const env = process.env;
  const configuredChannels = Array.isArray(cfg.alert.dingtalk.channels)
    ? cfg.alert.dingtalk.channels
    : [];
  if (configuredChannels.length) {
    cfg.alert.dingtalk.channels = configuredChannels.map((channel) => {
      const resolved = loadDingTalkCredentials({ env, channel: channel.name || 'regular' });
      return {
        ...channel,
        enabled: channel.enabled !== false && resolved.complete,
        webhook: resolved.credentials.webhook,
        secret: resolved.credentials.secret,
      };
    });
  } else {
    const regular = loadDingTalkCredentials({ env, channel: 'regular' });
    const operations = loadDingTalkCredentials({ env, channel: 'operations' });
    if (regular.credentials.webhook && operations.credentials.webhook) {
      cfg.alert.dingtalk.channels = [
        {
          name: 'regular', enabled: true,
          webhook: regular.credentials.webhook, secret: regular.credentials.secret,
          severities: ['OK', 'CRITICAL'], atMobiles: [], atAll: false,
        },
        {
          name: 'operations', enabled: true,
          webhook: operations.credentials.webhook, secret: operations.credentials.secret,
          severities: ['ERROR', 'WARN'], atMobiles: [], atAll: false,
        },
      ];
      cfg.alert.dingtalk.enabled = true;
      cfg.alert.dingtalk.webhook = '';
      cfg.alert.dingtalk.secret = '';
    } else if (regular.credentials.webhook) {
      // Legacy single-channel operation still receives every severity.
      cfg.alert.dingtalk.webhook = regular.credentials.webhook;
      cfg.alert.dingtalk.secret = regular.credentials.secret;
      cfg.alert.dingtalk.enabled = true;
    } else if (operations.credentials.webhook) {
      cfg.alert.dingtalk.channels = [{
        name: 'operations', enabled: true,
        webhook: operations.credentials.webhook, secret: operations.credentials.secret,
        severities: ['ERROR', 'WARN', 'CRITICAL'], atMobiles: [], atAll: false,
      }];
      cfg.alert.dingtalk.enabled = true;
    }
  }

  const crm = loadCrmCredentials({ env });
  if (crm.credentials.endpoint) {
    cfg.crm.endpoint = crm.credentials.endpoint;
    cfg.crm.enabled = true;
  }
  if (crm.credentials.token) cfg.crm.headers = { ...cfg.crm.headers, Authorization: `Bearer ${crm.credentials.token}` };

  const alertWebhook = loadAlertWebhookCredentials({ env });
  if (alertWebhook.credentials.url) {
    cfg.alert.webhook.url = alertWebhook.credentials.url;
    cfg.alert.webhook.enabled = true;
  }
  if (alertWebhook.credentials.authorization) {
    cfg.alert.webhook.headers = {
      ...cfg.alert.webhook.headers,
      Authorization: alertWebhook.credentials.authorization,
    };
  }
  if (env.ZINIAO_BIN) cfg.ziniao.bin = env.ZINIAO_BIN;
  if (env.ZINIAO_MODE) cfg.ziniao.mode = env.ZINIAO_MODE;
  if (env.ZINIAO_CLIENT_PATH) cfg.ziniao.webdriver.clientPath = env.ZINIAO_CLIENT_PATH;
  if (env.ZINIAO_SOCKET_PORT) cfg.ziniao.webdriver.socketPort = Number(env.ZINIAO_SOCKET_PORT);
  if (env.ZINIAO_CHROMEDRIVER) cfg.ziniao.webdriver.driverPath = env.ZINIAO_CHROMEDRIVER;
  if (env.CODEX_DISABLED === '1') cfg.codex.enabled = false;
  if (env.LOG_LEVEL) cfg.logLevel = env.LOG_LEVEL;
  return cfg;
}

function effectiveRows(config, rows) {
  const rules = readAdsRules(config.outDir);
  return rows.filter(store => store.enabled !== false).map(store => rules.has(store.key)
    ? { ...store, adsNameContains: rules.get(store.key) } : store);
}

/** Refresh non-secret store bindings after acquiring the shared run lease.
 * Does not load general configuration, environment credentials or Keychain.
 */
export function readEffectiveStores(config) {
  if (!config?._storesPath) throw new Error('缺少店铺配置来源，不能刷新店铺绑定');
  return effectiveRows(config, readStoreRegistry({ outDir: config.outDir,
    storesPath: config._storesPath, defaultHost: config.storeHealth?.defaultHost || DEFAULTS.storeHealth.defaultHost }).stores);
}

/** Preserve a started command's explicit selection and order, using fresh
 * bindings only. Injected offline fixtures without source metadata stay intact.
 */
export function refreshSelectedStores(config, previousStores) {
  if (!config?._storesPath) return previousStores;
  const current = new Map(readEffectiveStores(config).map(store => [store.key, store]));
  const selected = previousStores.map(store => current.get(store.key)).filter(Boolean);
  if (previousStores.length && !selected.length) throw new Error('选定店铺已停用或不存在，未启动店铺浏览器');
  return selected;
}

export function loadConfig({ configFile, storesFile } = {}) {
  const cfgPath = configFile
    ? path.resolve(configFile)
    : path.join(ROOT, 'config', 'config.json');
  const storesPath = storesFile
    ? path.resolve(storesFile)
    : path.join(ROOT, 'config', 'stores.json');

  let fileCfg = {};
  let usedExample = false;
  if (fs.existsSync(cfgPath)) {
    fileCfg = readJson(cfgPath);
    assertNoInlineSecrets(fileCfg, cfgPath);
  } else {
    const example = path.join(ROOT, 'config', 'config.example.json');
    if (fs.existsSync(example)) {
      fileCfg = readJson(example);
      assertNoInlineSecrets(fileCfg, example);
      usedExample = true;
    }
  }

  const config = applyEnv(deepMerge(DEFAULTS, fileCfg));
  config.outDir = path.isAbsolute(config.paths.outDir)
    ? config.paths.outDir
    : path.join(ROOT, config.paths.outDir);
  config._configPath = cfgPath;
  config._configFromExample = usedExample;
  config._root = ROOT;
  config._storesPath = storesPath;

  const registry = readStoreRegistry({ outDir: config.outDir, storesPath, defaultHost: config.storeHealth.defaultHost });
  const storesMissing = registry.source === 'missing';

  // Dashboard-managed advertising scope belongs in the writable runtime
  // area, not in root-controlled config/. Static values remain bootstrap
  // defaults; a durable runtime rule takes precedence for every process.
  const stores = effectiveRows(config, registry.stores);

  const seenStoreKeys = new Set();
  for (const store of stores) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(store.key || ''))) {
      throw new Error(`店铺 key 必须为 1-64 位字母、数字、点、下划线或连字符：${String(store.key || '(empty)')}`);
    }
    if (seenStoreKeys.has(store.key)) throw new Error(`店铺 key 重复：${store.key}`);
    seenStoreKeys.add(store.key);
  }

  return { config, stores, storesPath, storesMissing };
}
