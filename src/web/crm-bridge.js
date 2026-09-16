export const CRM_BRIDGE_STYLE = `:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#183047;background:#f3f6fa}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}.bridge-card{width:min(100%,460px);padding:36px;background:white;border:1px solid #dae3ed;border-radius:16px;box-shadow:0 14px 44px #17344e12}h1{font-size:23px;margin:0 0 16px}p{font-size:15px;line-height:1.7;margin:0;color:#42586c}.hint{font-size:13px;margin-top:20px;color:#687b8d}`;

export const CRM_BRIDGE_SCRIPT = `(${crmBridge.toString()})();`;

function crmBridge() {
  'use strict';
  const status = document.getElementById('crmBridgeStatus');
  let context;
  try { context = JSON.parse(document.getElementById('crmBridgeContext').textContent); }
  catch { status.textContent = '页面信息无效，请关闭窗口后从 CRM 重新进入。'; return; }
  const opener = window.opener;
  let finished = false;
  let accepted = false;
  let acceptedOrigin;
  let timer;
  let controller;
  const remaining = Math.min(120000, context.expiresAt - Date.now());
  const deadline = Date.now() + remaining;
  function cleanup() {
    window.removeEventListener('message', receive);
    clearTimeout(timer);
  }
  function fail(message) {
    if (finished) return;
    finished = true;
    cleanup();
    if (controller) controller.abort();
    status.textContent = message;
    window.opener = null;
  }
  function exact(data, fields) {
    return data && typeof data === 'object' && !Array.isArray(data)
      && Object.keys(data).length === fields.length
      && fields.every(key => Object.prototype.hasOwnProperty.call(data, key));
  }
  async function receive(event) {
    if (finished || accepted || event.source !== opener || window.opener !== opener || !context.bridgeOrigins.includes(event.origin)) return;
    const data = event.data;
    const fields = ['type', 'version', 'requestId', 'challengeId'];
    const ticketMessage = data && data.type === 'amzguard:crm:ticket';
    if (!exact(data, ticketMessage ? [...fields, 'loginUrl'] : fields)
      || data.version !== 1 || data.requestId !== context.requestId || data.challengeId !== context.challengeId
      || (!ticketMessage && data.type !== 'amzguard:crm:error')) return;
    if (opener.closed || Date.now() >= deadline) { fail('握手已结束，请关闭窗口后从 CRM 重新进入。'); return; }
    accepted = true;
    acceptedOrigin = event.origin;
    window.removeEventListener('message', receive);
    if (!ticketMessage) { fail('CRM 未完成授权，请关闭窗口并核对访问权限。'); return; }
    const prefix = context.publicOrigin + '/crm/sso#ticket=';
    if (typeof data.loginUrl !== 'string' || !data.loginUrl.startsWith(prefix)
      || !/^[A-Za-z0-9_-]{43}$/.test(data.loginUrl.slice(prefix.length))) {
      fail('登录地址校验失败，请关闭窗口后从 CRM 重新进入。'); return;
    }
    status.textContent = '正在建立只读会话…';
    controller = new AbortController();
    try {
      const response = await fetch('/crm/sso/exchange', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ticket: data.loginUrl.slice(prefix.length) }), signal: controller.signal,
      });
      if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('exchange');
      const body = await response.json();
      if (finished) return;
      if (body?.data?.location !== '/crm/') throw new Error('location');
      if (window.opener !== opener || opener.closed || Date.now() >= deadline) throw new Error('opener');
      opener.postMessage({ type: 'amzguard:crm:complete', version: 1,
        requestId: context.requestId, challengeId: context.challengeId }, acceptedOrigin);
      finished = true;
      cleanup();
      window.opener = null;
      window.location.replace('/crm/');
    } catch { fail('只读会话未完成，请关闭窗口后从 CRM 重新进入。系统不会自动重试。'); }
  }
  if (!opener || opener.closed || window.top !== window.self) {
    fail('请从 CRM 的入口打开此窗口。'); return;
  }
  if (!Number.isFinite(remaining) || remaining <= 0) {
    fail('握手已过期，请关闭窗口后从 CRM 重新进入。'); return;
  }
  timer = setTimeout(() => fail('握手已过期，请关闭窗口后从 CRM 重新进入。'), remaining);
  window.addEventListener('message', receive);
  try {
    for (const origin of context.bridgeOrigins) opener.postMessage({ type: 'amzguard:crm:challenge', version: 1,
      requestId: context.requestId, challengeId: context.challengeId,
      storeKey: context.storeKey, view: context.view, checkId: context.checkId }, origin);
  } catch { fail('无法连接 CRM 窗口，请关闭后重新进入。'); }
}

/** Only public handshake metadata is rendered; the separate binding token is cookie-only. */
export function renderCrmBridge({ requestId, challengeId, storeKey, view, checkId,
  bridgeOrigins, publicOrigin, expiresAt }) {
  const context = JSON.stringify({ requestId, challengeId, storeKey, view, checkId,
    bridgeOrigins, bridgeOrigin: bridgeOrigins && bridgeOrigins[0], publicOrigin, expiresAt }).replace(/[<>&\u2028\u2029]/g,
    character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CRM 只读访问</title><style>${CRM_BRIDGE_STYLE}</style></head><body><main class="bridge-card"><h1>连接店铺监测</h1><p id="crmBridgeStatus" role="status" aria-live="polite">正在等待 CRM 授权…</p><p class="hint">此入口仅查看已保存数据。握手有效期为 2 分钟。</p></main><script type="application/json" id="crmBridgeContext">${context}</script><script>${CRM_BRIDGE_SCRIPT}</script></body></html>`;
}
