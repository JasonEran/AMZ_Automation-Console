import { redactText, sanitizeForStorage, sanitizeUrl } from './redact.js';

/**
 * Push a finished check summary to a remote dashboard.
 *
 * Used when collection runs on one machine (wherever Ziniao lives) and the
 * dashboard runs on another. Enabled by the AMZGUARD_INGEST env var; when unset
 * this is a no-op, because the common case is collector and dashboard on the
 * same box reading the same out/ directory.
 *
 * Failure here never fails the check — the local report files are already
 * written by the time this runs.
 */
export async function pushToDashboard({ summary, logger }) {
  const url = process.env.AMZGUARD_INGEST;
  if (!url) return { attempted: false, reason: 'AMZGUARD_INGEST 未设置（看板与采集同机时不需要）' };

  let endpoint;
  try { endpoint = new URL(url); } catch { return { attempted: false, ok: false, reason: 'AMZGUARD_INGEST 不是合法 URL' }; }
  if (endpoint.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)) {
    return { attempted: false, ok: false, reason: '远程看板接收地址必须使用 HTTPS' };
  }

  const token = process.env.AMZGUARD_INGEST_TOKEN || process.env.INGEST_TOKEN || '';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Ingest-Token': token } : {}),
      },
      body: JSON.stringify(sanitizeForStorage(summary)),
      signal: ac.signal,
    });
    const body = await res.text().catch(() => '');
    if (res.ok) {
      logger?.info?.(`看板已更新 (${sanitizeUrl(url)})`);
      return { attempted: true, ok: true, status: res.status };
    }
    logger?.warn?.(`推送看板失败 HTTP ${res.status}`);
    return { attempted: true, ok: false, status: res.status };
  } catch (e) {
    const msg = e.name === 'AbortError' ? 'timeout 20s' : redactText(String(e.message || e));
    logger?.warn?.(`推送看板异常: ${msg}`);
    return { attempted: true, ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}
