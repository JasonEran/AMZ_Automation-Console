/** Local Dashboard administration; no collector, upload, or CRM write calls. */
export const STORE_SETTINGS_STYLES = `
  .store-settings-form .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  .store-settings-summary{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:0 20px 16px;color:var(--muted);font-size:12px}
  .store-settings-list{padding:0 20px 16px;display:grid;gap:9px}.store-settings-row{display:grid;grid-template-columns:minmax(160px,1fr) 65px 75px auto;align-items:center;gap:12px;border:1px solid var(--line);border-radius:10px;padding:12px}.store-settings-row b,.store-settings-row small{display:block;overflow-wrap:anywhere}.store-settings-row small{font-size:11px;color:var(--muted);margin-top:3px}.store-settings-row button,.store-settings-summary button{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:8px 12px;color:var(--ink);cursor:pointer;font:inherit}
  .store-settings-form{padding:20px;border-top:1px solid var(--line)}.store-settings-form[hidden]{display:none}.store-settings-form fieldset{border:0;padding:0;margin:0;min-width:0}.store-settings-form legend{font-size:16px;font-weight:700;margin:0 0 14px}.store-settings-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.store-settings-fields .settings-field input,.store-settings-fields .settings-field select{width:100%;box-sizing:border-box}.store-settings-fields small{font-size:11px;line-height:1.7;color:var(--muted)}.store-settings-wide{grid-column:1/-1}.store-settings-actions{display:flex;align-items:center;gap:10px;margin-top:18px;flex-wrap:wrap}.store-settings-actions button{font:inherit}.store-settings-check{display:flex;align-items:center;gap:8px;font-size:12px}.store-settings-check input{width:auto}.store-settings-note{margin:0 0 16px;color:var(--muted);font-size:12px;line-height:1.8}.store-settings-form input[readonly]{background:var(--panel-soft);color:var(--muted)}.store-settings-form :disabled{cursor:not-allowed;opacity:.65}
  @media(max-width:640px){.store-settings-fields{grid-template-columns:1fr}.store-settings-row{grid-template-columns:minmax(0,1fr) auto}.store-settings-row>span{font-size:11px}.store-settings-list,.store-settings-form{padding:14px}.store-settings-summary{padding:0 14px 14px}}
`;

export const STORE_SETTINGS_MARKUP = `<div class="view" data-view-panel="stores">
  <div class="page-intro"><div><h2>店铺配置</h2><p>管理店铺接入与看板显示。保存配置不会立即发起 Amazon 采样。</p></div></div>
  <section class="section" id="storeRegistryCard">
    <div class="section-head"><div><h3>已配置店铺</h3><p>店铺标识长期保留；停用后保留历史记录。广告组合范围在<a href="#ads-watch" data-view="ads-watch">广告值守</a>中维护。</p></div><button class="primary" id="storeSettingsNew" type="button" disabled>新增店铺</button></div>
    <div class="store-settings-summary"><span id="storeSettingsStatus" role="status">正在读取权限…</span><button id="storeSettingsReload" type="button">重新加载配置</button></div>
    <div class="settings-card"><div class="controls"><input class="control" id="storeSettingsSearch" type="search" placeholder="搜索名称或店铺标识" aria-label="搜索已配置店铺"><select class="control" id="storeSettingsFilter" aria-label="筛选店铺启用状态"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select></div><div class="settings-message" id="storeSettingsMessage" role="status"></div></div>
    <div class="store-settings-list" id="storeSettingsList"></div><div class="pager" id="storeSettingsPager" aria-label="配置店铺分页"></div>
    <form class="store-settings-form" id="storeSettingsForm" hidden>
      <fieldset id="storeSettingsFields" disabled><legend id="storeSettingsFormTitle">新增店铺</legend>
        <div class="store-settings-fields">
          <div class="settings-field"><label for="storeSettingsKey">店铺标识</label><input id="storeSettingsKey" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}" autocomplete="off"><small>使用字母、数字、点、下划线或连字符；创建后不可修改。</small></div>
          <div class="settings-field"><label for="storeSettingsDisplayName">显示名称</label><input id="storeSettingsDisplayName" maxlength="160" autocomplete="off"><small>用于界面展示，留空时使用紫鸟名称或店铺标识。</small></div>
          <div class="settings-field"><label for="storeSettingsName">紫鸟店铺名称</label><input id="storeSettingsName" maxlength="160" autocomplete="off"><small>未填数字 ID 时按此名称精确匹配；请勿填写 Amazon 登录账号。</small></div>
          <div class="settings-field"><label for="storeSettingsId">紫鸟数字 browserId</label><input id="storeSettingsId" maxlength="30" pattern="[1-9][0-9]{0,29}" inputmode="numeric" autocomplete="off"><small id="storeSettingsBindingNote">名称和数字 ID 至少填一项；数字 ID 优先用于店铺绑定。</small></div>
          <div class="settings-field"><label for="storeSettingsMarket">Amazon 站点</label><select id="storeSettingsMarket" required></select></div>
          <div class="settings-field"><label for="storeSettingsHost">Seller Central 域名</label><select id="storeSettingsHost" required></select></div>
          <div class="store-settings-wide"><label class="store-settings-check"><input id="storeSettingsEnabled" type="checkbox">启用该店铺</label><small>新店默认停用。启用后按现有排程纳入监测；各项功能能否采集以实际站点支持和有效证据为准。</small></div>
        </div>
        <div class="store-settings-actions"><button class="primary" id="storeSettingsSave" type="submit">保存店铺</button><button class="btn" id="storeSettingsCancel" type="button">关闭编辑</button><span id="storeSettingsDraft" class="kpi-note" role="status"></span></div>
      </fieldset>
    </form>
  </section>
  <section class="section" id="uiSettingsCard">
    <div class="section-head"><div><h3>看板显示</h3><p>调整界面刷新与每页条数，不改变 Amazon 采样频率或任务排程。</p></div></div>
    <form class="store-settings-form" id="uiSettingsForm">
      <fieldset id="uiSettingsFields" disabled><legend class="sr-only">看板显示设置</legend>
        <p class="store-settings-note" id="uiSettingsAccess">正在读取显示配置…</p>
        <div class="store-settings-fields">
          <div class="settings-field"><label for="uiReportRefresh">报告刷新（秒）</label><input id="uiReportRefresh" type="number" min="5" max="300" step="1" required></div>
          <div class="settings-field"><label for="uiProgressRefresh">执行进度刷新（秒）</label><input id="uiProgressRefresh" type="number" min="1" max="30" step="1" required></div>
          <div class="settings-field"><label for="uiUploadRefresh">上传记录刷新（秒）</label><input id="uiUploadRefresh" type="number" min="5" max="120" step="1" required></div>
          <div class="settings-field"><label for="uiMatrixPageSize">每页店铺数</label><input id="uiMatrixPageSize" type="number" min="1" max="100" step="1" required></div>
          <div class="settings-field"><label for="uiListPageSize">每页列表条数</label><input id="uiListPageSize" type="number" min="1" max="100" step="1" required><small>上传任务列表最多 50 条 / 页。</small></div>
          <div class="settings-field"><label for="uiDefaultView">默认工作区</label><select id="uiDefaultView" required></select><small>地址已有工作区时优先保留；普通用户不会默认进入管理页面。</small></div>
        </div>
        <div class="store-settings-actions"><button class="primary" id="uiSettingsSave" type="submit">保存显示设置</button><span id="uiSettingsDraft" class="kpi-note" role="status"></span></div>
      </fieldset><div class="settings-message" id="uiSettingsMessage" role="status"></div>
    </form>
  </section>
</div>`;

/** Serialized into the Dashboard; every dependency is passed explicitly. */
export function installStoreSettings({ window, document, views, settingsDefaults, onUiSettings, onStoresSaved }) {
  const q = selector => document.querySelector(selector);
  const fieldIds = { key: 'storeSettingsKey', name: 'storeSettingsName', displayName: 'storeSettingsDisplayName',
    id: 'storeSettingsId', market: 'storeSettingsMarket', host: 'storeSettingsHost', enabled: 'storeSettingsEnabled' };
  const uiFields = { reportRefreshSeconds: ['uiReportRefresh', 5, 300], progressRefreshSeconds: ['uiProgressRefresh', 1, 30],
    uploadRefreshSeconds: ['uiUploadRefresh', 5, 120], matrixPageSize: ['uiMatrixPageSize', 1, 100],
    listPageSize: ['uiListPageSize', 1, 100] };
  const defaults = { ...settingsDefaults };
  let registry = null, uiContext = null, uiSettings = { ...defaults }, editingKey = null, original = null;
  let storeDirty = false, uiDirty = false, storeSaving = false, uiSaving = false, listPage = 1;
  let storeLoading = null, uiLoading = null;
  const message = (id, text, kind = 'bad') => { const node = q('#' + id); node.textContent = text; node.className = 'settings-message ' + kind; };
  const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const canManage = () => uiContext?.canManage === true;

  async function request(url, method = 'GET', payload, csrfToken) {
    const headers = { Accept: 'application/json' };
    if (csrfToken) headers['x-amzguard-csrf'] = csrfToken;
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    const response = await window.fetch(url, { method, headers, credentials: 'same-origin', cache: 'no-store',
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
    if (response.status === 401) { window.location.href = '/login'; throw Object.assign(new Error('登录已过期，请重新登录。'), { status: 401 }); }
    const type = response.headers.get('content-type') || '';
    let body;
    try { if (!/application\/(?:json|problem\+json)/i.test(type)) throw new Error(); body = await response.json(); }
    catch { throw Object.assign(new Error('服务器未返回有效配置，请稍后重新加载。'), { status: response.status }); }
    if (!response.ok) throw Object.assign(new Error(typeof body?.error === 'string' ? body.error : '配置请求失败，请重新加载。'), { status: response.status, code: body?.code });
    return body;
  }

  function normalizedSettings(settings) {
    const result = { ...defaults };
    for (const [key, [, min, max]] of Object.entries(uiFields)) {
      if (Number.isInteger(settings?.[key]) && settings[key] >= min && settings[key] <= max) result[key] = settings[key];
    }
    if (views.some(view => view.id === settings?.defaultView)) result.defaultView = settings.defaultView;
    return result;
  }
  function options(select, values, selected) {
    select.replaceChildren();
    for (const value of values) { const option = element('option', value); option.value = value; select.append(option); }
    if (selected && !values.includes(selected)) { const option = element('option', selected + '（旧配置，请核对）'); option.value = selected; select.append(option); }
    if (!selected) { const empty = element('option', '请选择'); empty.value = ''; select.append(empty); }
    select.value = selected || '';
  }
  function renderUi() {
    for (const [key, [id]] of Object.entries(uiFields)) q('#' + id).value = String(uiSettings[key]);
    const select = q('#uiDefaultView'); select.replaceChildren();
    for (const view of views) { const option = element('option', view.title); option.value = view.id; select.append(option); }
    select.value = uiSettings.defaultView;
    q('#uiSettingsFields').disabled = !canManage() || uiSaving;
    q('#uiSettingsAccess').textContent = canManage() ? '管理员可修改；保存后当前页面立即采用新设置。' : '当前账户可查看显示配置；只有管理员可以修改。';
    q('#uiSettingsDraft').textContent = uiDirty ? '有未保存的修改' : '';
  }
  function storeFields() {
    return Object.fromEntries(Object.entries(fieldIds).map(([field, id]) => [field,
      field === 'enabled' ? q('#' + id).checked : q('#' + id).value]));
  }
  function setForm(store, creating = false) {
    editingKey = creating ? null : store.key;
    original = Object.fromEntries(Object.keys(fieldIds).map(key => [key, key === 'enabled' ? store.enabled === true : String(store[key] || '')]));
    const markets = registry.options.markets, hosts = registry.options.hosts;
    options(q('#storeSettingsMarket'), markets, original.market || (creating ? (markets.includes('US') ? 'US' : markets[0]) : ''));
    options(q('#storeSettingsHost'), hosts, original.host || (creating ? (hosts.includes('sellercentral.amazon.com') ? 'sellercentral.amazon.com' : hosts[0]) : ''));
    for (const [field, id] of Object.entries(fieldIds)) {
      if (field === 'enabled') q('#' + id).checked = original.enabled;
      else if (!['market', 'host'].includes(field)) q('#' + id).value = original[field];
    }
    q('#storeSettingsKey').readOnly = !creating;
    q('#storeSettingsFormTitle').textContent = creating ? '新增店铺' : '编辑店铺 · ' + store.key;
    q('#storeSettingsBindingNote').textContent = store.legacyBinding
      ? '旧绑定已隐藏，留空保留。填写新的数字 browserId 才会申请替换绑定。'
      : '名称和数字 ID 至少填一项；数字 ID 优先用于店铺绑定。';
    q('#storeSettingsForm').hidden = false;
    q('#storeSettingsFields').disabled = !canManage() || storeSaving;
    storeDirty = false; q('#storeSettingsDraft').textContent = '';
  }
  function discardDraft() { return !storeDirty || window.confirm('放弃当前未保存的店铺修改？'); }
  function edit(store, creating = false) {
    if (!canManage() || !registry || storeSaving || !discardDraft()) return;
    setForm(store, creating);
    q('#storeSettingsForm').scrollIntoView?.({ block: 'nearest' });
    q(creating ? '#storeSettingsKey' : '#storeSettingsDisplayName').focus();
  }
  function renderStores() {
    const list = q('#storeSettingsList'), pager = q('#storeSettingsPager'); list.replaceChildren(); pager.replaceChildren();
    q('#storeSettingsNew').disabled = !canManage() || !registry || storeSaving;
    q('#storeSettingsSearch').disabled = q('#storeSettingsFilter').disabled = !canManage() || !registry;
    if (!registry || !canManage()) return;
    q('#storeSettingsStatus').textContent = registry.stores.length + ' 家店铺 · ' + registry.stores.filter(store => store.enabled).length + ' 家已启用';
    const term = q('#storeSettingsSearch').value.trim().toLowerCase(), filter = q('#storeSettingsFilter').value;
    const rows = registry.stores.filter(store => (!term || [store.key, store.name, store.displayName, store.market].join(' ').toLowerCase().includes(term))
      && (filter === 'all' || (filter === 'enabled' ? store.enabled : !store.enabled)));
    const size = uiSettings.listPageSize, total = Math.max(1, Math.ceil(rows.length / size));
    listPage = Math.max(1, Math.min(listPage, total));
    for (const store of rows.slice((listPage - 1) * size, listPage * size)) {
      const row = element('article', undefined, 'store-settings-row'), label = element('div');
      label.append(element('b', store.displayName || store.name || store.key), element('small', store.key));
      const button = element('button', '编辑'); button.type = 'button'; button.disabled = storeSaving;
      button.setAttribute('aria-label', '编辑店铺 ' + (store.displayName || store.key)); button.addEventListener('click', () => edit(store));
      row.append(label, element('span', store.market), element('span', store.enabled ? '已启用' : '已停用'), button); list.append(row);
    }
    if (!rows.length) list.append(element('p', '没有符合条件的店铺。', 'empty'));
    const previous = element('button', '上一页'), next = element('button', '下一页');
    previous.type = next.type = 'button'; previous.disabled = listPage <= 1; next.disabled = listPage >= total;
    previous.addEventListener('click', () => { listPage--; renderStores(); }); next.addEventListener('click', () => { listPage++; renderStores(); });
    pager.append(previous, element('span', '第 ' + listPage + ' / ' + total + ' 页 · ' + rows.length + ' 家'), next);
  }
  function validRegistry(body) {
    return body?.canManage === true && typeof body.revision === 'string' && Array.isArray(body.stores)
      && Array.isArray(body.options?.markets) && body.options.markets.length && body.options.markets.every(value => typeof value === 'string')
      && Array.isArray(body.options?.hosts) && body.options.hosts.length && body.options.hosts.every(value => typeof value === 'string');
  }
  function lostAccess() {
    registry = null; original = null; editingKey = null; storeDirty = false;
    if (uiContext) uiContext.canManage = false;
    for (const [field, id] of Object.entries(fieldIds)) { if (field === 'enabled') q('#' + id).checked = false; else q('#' + id).value = ''; }
    q('#storeSettingsForm').hidden = true; q('#storeSettingsFields').disabled = true;
    q('#storeSettingsStatus').textContent = '只有管理员可以查看和维护店铺接入配置。'; renderStores(); renderUi();
  }
  async function loadStores() {
    if (!canManage()) { lostAccess(); return null; }
    if (storeDirty || storeSaving) return registry;
    if (storeLoading) return storeLoading;
    storeLoading = (async () => {
      try {
        const body = await request('/api/admin/stores', 'GET', undefined, uiContext.csrfToken);
        if (!validRegistry(body)) throw new Error('店铺配置格式不完整，请重新加载。');
        if (storeDirty || storeSaving) return registry;
        registry = body; renderStores(); return body;
      } catch (error) {
        if (error.status === 403 || error.status === 401) lostAccess();
        message('storeSettingsMessage', error.status === 403 ? '当前账户没有店铺管理权限。' : error.message); return null;
      } finally { storeLoading = null; }
    })();
    return storeLoading;
  }
  async function loadUIConfig() {
    if (uiDirty || uiSaving) return uiContext;
    if (uiLoading) return uiLoading;
    uiLoading = (async () => {
      try {
        const body = await request('/api/ui-config');
        if (typeof body?.revision !== 'string' || !body.settings) throw new Error('显示配置格式不完整，请重新加载。');
        if (uiDirty || uiSaving) return uiContext;
        uiContext = body; uiSettings = normalizedSettings(body.settings); renderUi(); onUiSettings?.(uiSettings);
        if (!canManage()) lostAccess();
        return body;
      } catch (error) {
        if (error.status === 401 || error.status === 403) lostAccess();
        message('uiSettingsMessage', error.message); if (!uiDirty) renderUi(); onUiSettings?.(uiSettings); return null;
      } finally { uiLoading = null; }
    })();
    return uiLoading;
  }
  async function saveStore(event) {
    event.preventDefault(); if (!canManage() || !registry || storeSaving || !original) return;
    const current = storeFields(), creating = editingKey === null;
    const store = creating ? current : Object.fromEntries(Object.entries(current).filter(([key, value]) => key !== 'key' && value !== original[key]));
    if (!creating && !Object.keys(store).length) { message('storeSettingsMessage', '没有需要保存的修改。', 'neutral'); return; }
    storeSaving = true; q('#storeSettingsFields').disabled = true; renderStores();
    try {
      const key = creating ? current.key : editingKey;
      const body = await request('/api/admin/stores' + (creating ? '' : '/' + encodeURIComponent(editingKey)), creating ? 'POST' : 'PATCH',
        { expectedRevision: registry.revision, [creating ? 'store' : 'patch']: store }, registry.csrfToken);
      if (!validRegistry(body)) throw new Error('保存响应不完整，请重新加载确认配置。');
      registry = body; const saved = registry.stores.find(row => row.key === key);
      storeDirty = false; if (saved) setForm(saved); else q('#storeSettingsForm').hidden = true;
      renderStores(); message('storeSettingsMessage', '店铺配置已保存。后续任务按新配置运行；本次保存没有发起采样。', 'ok');
      try { await onStoresSaved?.(); } catch { message('storeSettingsMessage', '店铺配置已保存，但看板刷新失败；可稍后手动刷新。', 'neutral'); }
    } catch (error) {
      if (error.status === 403 || error.status === 401) lostAccess();
      message('storeSettingsMessage', error.status === 409 ? '配置版本或当前绑定状态不允许保存，草稿已保留。请核对提示并重新加载配置后再修改。' + (error.message ? ' ' + error.message : '') : error.message);
    } finally { storeSaving = false; q('#storeSettingsFields').disabled = !canManage(); renderStores(); }
  }
  async function saveUi(event) {
    event.preventDefault(); if (!canManage() || !uiContext || uiSaving) return;
    const settings = { defaultView: q('#uiDefaultView').value };
    for (const [key, [id, min, max]] of Object.entries(uiFields)) {
      const value = Number(q('#' + id).value);
      if (!Number.isInteger(value) || value < min || value > max) { message('uiSettingsMessage', '请按页面范围填写整数。'); return; }
      settings[key] = value;
    }
    if (!views.some(view => view.id === settings.defaultView)) { message('uiSettingsMessage', '请选择有效工作区。'); return; }
    uiSaving = true; q('#uiSettingsFields').disabled = true;
    try {
      const body = await request('/api/admin/ui-config', 'PUT', { expectedRevision: uiContext.revision, settings }, uiContext.csrfToken);
      if (typeof body?.revision !== 'string' || !body.settings) throw new Error('保存响应不完整，请重新加载确认配置。');
      uiContext = body; uiSettings = normalizedSettings(body.settings); uiDirty = false; renderUi(); onUiSettings?.(uiSettings); renderStores();
      message('uiSettingsMessage', '显示设置已保存并应用；Amazon 采样频率和排程没有改变。', 'ok');
    } catch (error) {
      if (error.status === 403 || error.status === 401) lostAccess();
      message('uiSettingsMessage', error.status === 409 ? '显示配置已由其他管理员更新，草稿已保留。请重新加载配置后再修改。' : error.message);
    } finally { uiSaving = false; q('#uiSettingsFields').disabled = !canManage(); }
  }
  async function refresh(discard = false) {
    if (storeSaving || uiSaving) return;
    if (storeDirty || uiDirty) {
      if (!discard) { message('storeSettingsMessage', '未保存的草稿已保留。需要最新配置时请点击“重新加载配置”。', 'neutral'); return; }
      if (!window.confirm('重新加载会放弃未保存的店铺和显示设置草稿，是否继续？')) return;
    }
    storeDirty = uiDirty = false; original = null; q('#storeSettingsForm').hidden = true;
    message('storeSettingsMessage', '', 'neutral'); message('uiSettingsMessage', '', 'neutral');
    await loadUIConfig(); await loadStores();
  }
  q('#storeSettingsNew').addEventListener('click', () => edit({ enabled: false }, true));
  q('#storeSettingsCancel').addEventListener('click', () => { if (discardDraft()) { storeDirty = false; original = null; q('#storeSettingsForm').hidden = true; } });
  q('#storeSettingsReload').addEventListener('click', () => refresh(true));
  q('#storeSettingsSearch').addEventListener('input', () => { listPage = 1; renderStores(); });
  q('#storeSettingsFilter').addEventListener('change', () => { listPage = 1; renderStores(); });
  for (const type of ['input', 'change']) {
    q('#storeSettingsForm').addEventListener(type, () => { if (canManage() && !storeSaving) { storeDirty = true; q('#storeSettingsDraft').textContent = '有未保存的修改'; } });
    q('#uiSettingsForm').addEventListener(type, () => { if (canManage() && !uiSaving) { uiDirty = true; q('#uiSettingsDraft').textContent = '有未保存的修改'; } });
  }
  q('#storeSettingsForm').addEventListener('submit', saveStore); q('#uiSettingsForm').addEventListener('submit', saveUi);
  return { loadUIConfig, refresh, activate: () => registry ? Promise.resolve(registry) : loadStores(),
    getSettings: () => ({ ...uiSettings }),
    getDefaultView: () => !canManage() && ['users', 'stores'].includes(uiSettings.defaultView) ? 'overview' : uiSettings.defaultView };
}
