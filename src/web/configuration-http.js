import { acquireRunLock, releaseRunLock } from '../checks/run.js';
import { readAdsRules } from '../lib/ads-rules.js';
import { STORE_MARKETS, STORE_HOSTS, storeBindingChanged } from '../lib/store-registry.js';
import { assertStoreUploadBindingIdle } from '../lib/store-change-guard.js';

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
function payloadFields(payload, fields) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(key => !fields.includes(key))) {
    throw fail(400, 'CONFIG_INVALID_BODY', '请求必须是仅含规定字段的 JSON 对象');
  }
}

/** Dashboard administration only. Caller checks the local Dashboard session;
 * CRM identities never reach this handler. No collection or external requests.
 */
export function createConfigurationHttp({ outDir, registry, uiConfig, json, readJsonRequest,
  validAdminRole, requireProtectedMutation, csrfToken, sessionClaims, refreshStores }) {
  function storesContext(req) {
    const snapshot = registry.read(), rules = readAdsRules(outDir);
    return { ...snapshot, stores: snapshot.stores.map(store => ({
      key: store.key, name: store.name, displayName: store.displayName, market: store.market,
      host: store.host, enabled: store.enabled,
      id: /^[1-9][0-9]*$/.test(store.id) ? store.id : '',
      legacyBinding: Boolean(store.id && !/^[1-9][0-9]*$/.test(store.id)),
      adsNameContains: rules.has(store.key) ? rules.get(store.key) : store.adsNameContains,
    })), csrfToken: csrfToken(req), canManage: true,
    options: { markets: STORE_MARKETS, hosts: STORE_HOSTS } };
  }
  function uiContext(req) {
    const snapshot = uiConfig.read(), canManage = validAdminRole(req);
    if (!canManage && ['users', 'stores'].includes(snapshot.settings.defaultView)) snapshot.settings.defaultView = 'overview';
    return { ...snapshot, csrfToken: csrfToken(req), canManage };
  }
  return async (req, res, url) => {
    const p = url.pathname;
    const isStore = p === '/api/admin/stores', isStoreItem = p.startsWith('/api/admin/stores/');
    const isUiRead = p === '/api/ui-config', isUiWrite = p === '/api/admin/ui-config';
    if (!isStore && !isStoreItem && !isUiRead && !isUiWrite) return false;
    try {
      if (!isUiRead && !validAdminRole(req)) throw fail(403, 'CONFIG_ADMIN_REQUIRED', '需要 Dashboard 管理员权限');
      const allowed = isStore ? ['GET', 'POST'] : isStoreItem ? ['PATCH'] : isUiRead ? ['GET'] : ['PUT'];
      if (!allowed.includes(req.method)) {
        res.setHeader('Allow', allowed.join(', '));
        throw fail(405, 'CONFIG_METHOD_NOT_ALLOWED', '此配置接口不支持该方法');
      }
      if (url.search) throw fail(400, 'CONFIG_INVALID_QUERY', '配置接口不接受查询参数');
      if (req.method === 'GET') {
        json(res, 200, isStore ? storesContext(req) : uiContext(req));
        return true;
      }
      if (!requireProtectedMutation(req, res)) return true;
      const payload = await readJsonRequest(req);
      if (!validAdminRole(req)) throw fail(403, 'CONFIG_ADMIN_REQUIRED', '管理员会话已失效，请重新登录');
      const actor = sessionClaims(req)?.username || 'local-admin';
      if (isUiWrite) {
        payloadFields(payload, ['expectedRevision', 'settings']);
        uiConfig.save({ ...payload, actor });
        json(res, 200, uiContext(req));
        return true;
      }
      payloadFields(payload, ['expectedRevision', isStore ? 'store' : 'patch']);
      let key = '', before;
      if (isStoreItem) {
        try { key = decodeURIComponent(p.slice('/api/admin/stores/'.length)); }
        catch { throw fail(400, 'CONFIG_INVALID_PATH', '店铺路径编码无效'); }
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key)) throw fail(400, 'CONFIG_INVALID_PATH', '店铺 key 路径无效');
        const snapshot = registry.read();
        if (snapshot.revision !== payload.expectedRevision) throw fail(409, 'STORE_REGISTRY_CONFLICT', '店铺配置已更新，请重载后重试');
        before = snapshot.stores.find(store => store.key === key);
        if (!before) throw fail(404, 'STORE_REGISTRY_NOT_FOUND', '店铺不存在');
      }
      // Cosmetic edits are safe during collection; every binding/enable change
      // shares the same lease as collectors and the independent upload worker.
      const after = { ...before, ...payload.patch };
      const bindingChange = before && storeBindingChanged(before, after);
      const enabledChange = before && before.enabled !== after.enabled;
      const needsLease = Boolean(bindingChange || enabledChange || (isStore && payload.store?.enabled === true));
      let lease;
      try {
        if (needsLease) lease = acquireRunLock({ outDir, label: 'store-configuration' });
        if (bindingChange || (enabledChange && after.enabled === false)) {
          assertStoreUploadBindingIdle({ outDir, storeKey: key });
        }
        if (isStore) registry.create({ ...payload, actor });
        else registry.update(key, { ...payload, actor });
        refreshStores();
      } finally { if (lease) releaseRunLock(lease); }
      json(res, isStore ? 201 : 200, storesContext(req));
    } catch (cause) {
      const active = cause.code === 'RUN_ALREADY_ACTIVE';
      const status = active ? 409 : (cause.status || cause.statusCode || 500);
      json(res, status, { ok: false, code: active ? 'CONFIG_RUN_ACTIVE' : cause.code || 'CONFIG_REQUEST_FAILED',
        error: active ? '监测或上传工作者正在运行，请待本次运行结束后修改店铺绑定或启停状态'
          : status === 500 ? '配置请求未完成，请重载核对保存结果' : cause.message });
    }
    return true;
  };
}
