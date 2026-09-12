const LOGIN_STATUS = new Set(['LOGIN_REQUIRED', 'AUTH_REQUIRED', 'MFA_REQUIRED', 'PASSKEY_REQUIRED']);
const LOGIN_TERMS = /(?:登录|登陆|验证码|验证代码|Passkey|MFA|OTP|session\s*(?:expired|invalid)|sign[ -]?in|authentication)/i;

function atValue(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function reasonText(cell) {
  return [cell?.status, ...(Array.isArray(cell?.reasons) ? cell.reasons : [])]
    .filter(Boolean).join('；');
}

function isLoginFailure(cell) {
  const statuses = String(cell?.status || '').split(/\s*\/\s*/);
  return statuses.some((status) => LOGIN_STATUS.has(status)) || LOGIN_TERMS.test(reasonText(cell));
}

/**
 * Build a credential-free Ziniao session operations view from collected
 * results. It never probes Amazon or exposes cookies, OTP values or URLs.
 */
export function buildSessionHealth(storeRows) {
  return (Array.isArray(storeRows) ? storeRows : []).map((store) => {
    const cells = Object.entries(store.cells || {}).map(([checkId, cell]) => ({ checkId, ...cell }));
    const failures = cells.filter((cell) => cell.actionState === 'COLLECTION');
    const loginFailures = failures.filter(isLoginFailure);
    const successful = cells.filter((cell) => ['OK', 'WARN', 'CRITICAL'].includes(cell.state) && !cell.stale);
    const latestSuccess = [...successful].sort((a, b) => atValue(b.lastRunAt) - atValue(a.lastRunAt))[0];
    const latestFailure = [...failures].sort((a, b) => atValue(b.lastRunAt) - atValue(a.lastRunAt))[0];
    let state = 'PENDING';
    let label = '待建立会话';
    let suggestedAction = '等待首次紫鸟真机巡检完成';
    if (loginFailures.length) {
      state = 'BLOCKED';
      label = '登录流程受阻';
      suggestedAction = '检查紫鸟自动验证码权限、自动填充黑名单和店铺会话';
    } else if (failures.length) {
      state = 'DEGRADED';
      label = '采集链路异常';
      suggestedAction = '按失败检查项定向补跑并核对截图、DOM 与页面文本';
    } else if (successful.length) {
      state = 'READY';
      label = '会话可用';
      suggestedAction = '无需处理，继续按排程监测';
    }
    return {
      storeKey: store.key,
      storeName: store.name,
      market: store.market || '',
      state,
      label,
      collectionFailures: failures.length,
      loginFailures: loginFailures.length,
      lastSuccessfulAt: latestSuccess?.lastRunAt || null,
      lastFailureAt: latestFailure?.lastRunAt || null,
      lastFailureReason: latestFailure ? reasonText(latestFailure).slice(0, 500) : null,
      failedChecks: failures.map((cell) => cell.checkId),
      suggestedAction,
    };
  });
}
