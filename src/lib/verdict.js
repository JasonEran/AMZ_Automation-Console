/**
 * Node-side parser for the Account Health page's plain text, plus the logic that
 * reconciles the DOM extraction with the text extraction into one verdict.
 *
 * Having two independent extraction paths matters: Amazon reshuffles this SPA's
 * DOM regularly, and a silent "looks healthy" is the one failure mode we cannot
 * accept. When the two paths disagree, or neither can decide, we escalate rather
 * than guess.
 */

/** Requirement 1: only HEALTHY is normal. Everything else — including "we could
 *  not tell" — is an anomaly that must be reported. */
export const HEALTHY = 'HEALTHY';

export const STATUS_LABELS = {
  HEALTHY: '正常 (Healthy)',
  AT_RISK: '有风险 (At Risk)',
  UNHEALTHY: '不健康 (Unhealthy)',
  CRITICAL: '严重 (Critical)',
  DEACTIVATED: '已停用 (Deactivated)',
  UNKNOWN: '无法判定',
  LOGIN_REQUIRED: '未登录/需要登录',
  BLOCKED: '被拦截/验证码',
  ERROR: '检查失败',
  PARTIAL_EVIDENCE: '证据不完整',
  NOT_CONFIGURED: '尚未配置',
  PAGE_NOT_FOUND: '商品页面不存在',
  UNAVAILABLE: '商品不可售',
  NO_CART: '无购物车/Buy Box',
  LOW_RATING: '首次发现低分 Feedback',
  RECORDED_LOW_RATING: '低分 Feedback 已归档',
  LOW_REVIEW: '首次发现低星 Review',
  RECORDED_LOW_REVIEW: '低星 Review 已归档',
  POOR_CX: '首次发现 VOC 异常',
  RECORDED_BUSINESS_EVENT: 'VOC 业务事件已归档',
  RECORDED_PERFORMANCE_EVENT: '绩效事件已归档',
  NEW_BUYER_MESSAGE: '有未读/待回复买家消息',
  CLEAR: '正常（无待处理事项）',
};

// `\bhealthy\b` does not match inside "unhealthy" (n and h are both word chars),
// but list the longer word first anyway so the intent is explicit.
const TEXT_VOCAB = [
  ['UNHEALTHY', /\bunhealthy\b/i],
  ['UNHEALTHY', /不健康/],
  ['DEACTIVATED', /\bdeactivated\b/i],
  ['DEACTIVATED', /已停用/],
  ['CRITICAL', /\bcritical\b/i],
  ['CRITICAL', /严重/],
  ['AT_RISK', /\bat[\s-]?risk\b/i],
  ['AT_RISK', /有风险/],
  ['HEALTHY', /\bhealthy\b/i],
  ['HEALTHY', /良好/],
];

const LOGIN_RE =
  /(sign[\s-]*in to continue|amazon sign[\s-]*in|enter your password|email or mobile phone number|two[\s-]step verification|forgot your password)/i;
const BLOCK_RE =
  /(enter the characters you see|robot check|to discuss automated access|sorry, something went wrong|service unavailable)/i;

function squash(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Parse the Policy Compliance status and AHR score out of full page text.
 * @returns {{status:string, statusRaw:string|null, score:number|null, window:string|null,
 *            hasPolicyComplianceText:boolean, looksLikeLogin:boolean, looksBlocked:boolean,
 *            notes:string[]}}
 */
export function parsePolicyComplianceText(pageText) {
  const text = squash(pageText);
  const notes = [];
  const hasPC = /policy\s+compliance|政策合规性/i.test(text);
  const out = {
    status: 'UNKNOWN',
    statusRaw: null,
    score: null,
    window: null,
    hasPolicyComplianceText: hasPC,
    looksLikeLogin: LOGIN_RE.test(text) && !hasPC,
    looksBlocked: BLOCK_RE.test(text) && !hasPC,
    notes,
  };

  if (!text) {
    notes.push('页面文本为空');
    return out;
  }
  if (out.looksLikeLogin) {
    out.status = 'LOGIN_REQUIRED';
    return out;
  }
  if (out.looksBlocked) {
    out.status = 'BLOCKED';
    return out;
  }
  if (!hasPC) {
    notes.push("页面文本中没有 'Policy Compliance'，可能未加载完成或跳转到了别的页面");
    return out;
  }

  // "Policy Compliance" appears more than once on the real page: the tab strip
  // says "Product Policy Compliance" well before the actual card does. Taking
  // the first match therefore reads the tab and finds no status. So score every
  // occurrence and keep the one that actually looks like the card.
  const windows = [];
  const finder = /policy\s+compliance\b|政策合规性/gi;
  let fm;
  while ((fm = finder.exec(text)) !== null) {
    const win = squash(text.slice(fm.index + fm[0].length, fm.index + fm[0].length + 260));
    let status = null;
    let raw = null;
    for (const [st, re] of TEXT_VOCAB) {
      const hit = re.exec(win);
      if (hit) {
        status = st;
        raw = hit[0];
        break;
      }
    }
    windows.push({
      at: fm.index,
      win,
      status,
      raw,
      // The card is the occurrence followed by the rating widget.
      hasRating: /account\s+health\s+rating|账户状况评级/i.test(win),
    });
    if (windows.length >= 12) break;
  }

  // Preference order: status + rating (definitely the card) > status alone >
  // rating alone (card found but no status word) > first occurrence.
  const best =
    windows.find((w) => w.status && w.hasRating) ||
    windows.find((w) => w.status) ||
    windows.find((w) => w.hasRating) ||
    windows[0];

  if (best) {
    out.window = best.win.slice(0, 240) || null;
    if (best.status) {
      out.status = best.status;
      out.statusRaw = best.raw;
    }
    if (windows.length > 1) {
      notes.push(`页面出现 ${windows.length} 处 'Policy Compliance'，采用${best.hasRating ? '带评分控件的' : '含状态词的'}那一处`);
    }
  }
  if (out.status === 'UNKNOWN') {
    notes.push("'Policy Compliance' 后 260 字内没有出现任何已知状态词");
  }

  const searchIn = best?.hasRating ? best.win : text;
  const sm = /(?:account\s+health\s+rating\b|账户状况评级)([\s\S]{0,200})/i.exec(searchIn);
  if (sm) {
    // Prefer the first 1-3 digit number that is not one of the axis ticks.
    const nums = (sm[1].match(/\b\d{1,4}\b/g) || []).map(Number).filter((n) => n >= 0 && n <= 1000);
    const ticks = new Set([0, 100, 200, 1000]);
    const nonTick = nums.find((n) => !ticks.has(n));
    if (nonTick !== undefined) out.score = nonTick;
    else if (nums.length) {
      out.score = nums[0];
      notes.push('AHR 分数只匹配到坐标刻度值，可能不准确');
    }
  }
  return out;
}

const SEVERITY_BY_STATUS = {
  HEALTHY: 'OK',
  AT_RISK: 'CRITICAL',
  UNHEALTHY: 'CRITICAL',
  CRITICAL: 'CRITICAL',
  DEACTIVATED: 'CRITICAL',
  LOGIN_REQUIRED: 'ERROR',
  BLOCKED: 'ERROR',
  UNKNOWN: 'ERROR',
  ERROR: 'ERROR',
};

/** Rank used to pick the more alarming of two disagreeing readings. */
const ALARM_RANK = {
  HEALTHY: 0,
  UNKNOWN: 1,
  LOGIN_REQUIRED: 2,
  BLOCKED: 2,
  ERROR: 2,
  AT_RISK: 3,
  UNHEALTHY: 4,
  CRITICAL: 5,
  DEACTIVATED: 6,
};

export function severityOf(status) {
  return SEVERITY_BY_STATUS[status] || 'ERROR';
}

export function isDecided(status) {
  return ['HEALTHY', 'AT_RISK', 'UNHEALTHY', 'CRITICAL', 'DEACTIVATED'].includes(status);
}

/**
 * Fold the DOM reading and the text reading into a single verdict.
 *
 * @param {object|null} dom  result of the in-page extractor
 * @param {object|null} txt  result of parsePolicyComplianceText
 * @returns {{status:string, source:string, confidence:'high'|'medium'|'low'|'conflict',
 *            needsArbitration:boolean, score:number|null, scoreSource:string|null, notes:string[]}}
 */
export function reconcile(dom, txt) {
  const notes = [];
  const domStatus = dom?.status || 'UNKNOWN';
  const txtStatus = txt?.status || 'UNKNOWN';

  // Hard blockers win outright, from whichever path saw them.
  for (const [flag, status] of [
    ['looksLikeLogin', 'LOGIN_REQUIRED'],
    ['looksBlocked', 'BLOCKED'],
  ]) {
    if (dom?.[flag] || txt?.[flag]) {
      notes.push(`检测到 ${status}`);
      return {
        status,
        source: dom?.[flag] ? 'dom' : 'text',
        confidence: 'high',
        needsArbitration: false,
        score: null,
        scoreSource: null,
        notes,
      };
    }
  }

  const domOk = isDecided(domStatus);
  const txtOk = isDecided(txtStatus);

  let status;
  let source;
  let confidence;
  let needsArbitration = false;

  if (domOk && txtOk && domStatus === txtStatus) {
    status = domStatus;
    source = 'dom+text';
    confidence = 'high';
  } else if (domOk && txtOk) {
    // Disagreement. Fail safe toward the more alarming reading and flag it for
    // arbitration; never let a conflict resolve silently to HEALTHY.
    const worse = ALARM_RANK[domStatus] >= ALARM_RANK[txtStatus] ? domStatus : txtStatus;
    status = worse;
    source = 'conflict';
    confidence = 'conflict';
    needsArbitration = true;
    notes.push(`DOM 判定 ${domStatus}，文本判定 ${txtStatus}，取更严重的 ${worse}`);
  } else if (domOk) {
    status = domStatus;
    source = 'dom';
    confidence = dom?.statusSource === 'pagetext-window' ? 'low' : 'medium';
    notes.push('仅 DOM 路径给出判定');
    if (confidence === 'low') needsArbitration = true;
  } else if (txtOk) {
    status = txtStatus;
    source = 'text';
    confidence = 'medium';
    notes.push('仅文本路径给出判定');
  } else {
    status = 'UNKNOWN';
    source = 'none';
    confidence = 'low';
    needsArbitration = true;
    notes.push('两条路径都无法判定');
  }

  // AHR score: DOM's font-size ranking is more trustworthy than a text regex.
  let score = null;
  let scoreSource = null;
  if (Number.isFinite(dom?.score)) {
    score = dom.score;
    scoreSource = `dom:${dom.scoreSource || 'unknown'}`;
  }
  if (Number.isFinite(txt?.score)) {
    if (score === null) {
      score = txt.score;
      scoreSource = 'text';
    } else if (txt.score !== score) {
      notes.push(`AHR 分数不一致：DOM=${score}，文本=${txt.score}，采用 DOM`);
    } else {
      scoreSource = 'dom+text';
    }
  }

  for (const n of dom?.notes || []) notes.push(`dom: ${n}`);
  for (const n of txt?.notes || []) notes.push(`text: ${n}`);

  return { status, source, confidence, needsArbitration, score, scoreSource, notes };
}
