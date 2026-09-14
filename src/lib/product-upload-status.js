const KNOWN_STATES = new Set([
  'IN_PROGRESS', 'ACTION_REQUIRED', 'DONE', 'FAILED', 'SAVED_AS_DRAFTS',
  'PUBLISHED', 'REJECTED', 'NO_DATA_FOUND',
]);
const SUCCESS_STATES = new Set(['DONE', 'PUBLISHED']);
const FAILED_STATES = new Set(['FAILED', 'REJECTED']);
const MAX_RECORD_COUNT = 10000000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function count(value) {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RECORD_COUNT ? value : null;
}

function batchIdentifier(row) {
  const direct = row.batchId;
  const nested = object(row.feedIdentifier) ? row.feedIdentifier.batchId : undefined;
  if (direct !== undefined && nested !== undefined && direct !== nested) return null;
  const value = direct ?? nested;
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value) ? value : null;
}

function submittedAt(value) {
  // Amazon's date formatter treats an ISO timestamp without a zone as UTC.
  // Never parse the localized date displayed below the filename.
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const date = new Date(zone ? value : `${value}Z`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function splitResult(value) {
  const state = object(value) && object(value.processingState) ? value.processingState.name : null;
  const rawState = typeof state === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(state) ? state : null;
  const statistics = object(value) && object(value.processingStatistics) ? value.processingStatistics : {};
  const submitted = count(statistics.numRecordsSubmitted);
  const success = count(statistics.numRecordsSuccessful);
  return { state: rawState, submitted, success,
    invalidCounts: (statistics.numRecordsSubmitted != null && submitted === null)
      || (statistics.numRecordsSuccessful != null && success === null),
    conflictingCounts: submitted !== null && success !== null && success > submitted };
}

/** Normalize a uniquely matched, DOM-correlated Amazon status row. The caller
 * verifies store/batch/file identity and page safety. This function never returns
 * action URLs, account data, tokens, localized source text or the original row. */
export function normalizeProductUploadStatusRow(value) {
  const row = object(value) ? value : {};
  const result = {
    version: 1,
    source: 'AMAZON_UPLOAD_STATUS_ROW',
    batchId: batchIdentifier(row),
    status: 'UNKNOWN',
    statusText: '尚不能确认 Amazon 的处理结果',
    processingState: null,
    submittedAt: submittedAt(row.submissionDate),
    counts: { submitted: null, success: null, failed: null, warning: null },
  };
  // The upload table uses splitStatuses. A legacy top-level processingState is
  // also used by other report tables and is not sufficient upload evidence.
  if (!Array.isArray(row.splitStatuses) || !row.splitStatuses.length || row.splitStatuses.length > 1000) return result;
  const splits = row.splitStatuses.map(splitResult);
  const states = new Set(splits.map(split => split.state));
  result.processingState = states.size === 1 ? splits[0].state : 'MIXED';
  if (splits.length === 1 && !splits[0].conflictingCounts) {
    result.counts.submitted = splits[0].submitted;
    result.counts.success = splits[0].success;
  }
  if (!result.batchId) {
    result.statusText = 'Amazon 批次标识缺失或不一致，尚不能确认处理结果';
    return result;
  }
  if (splits.some(split => !KNOWN_STATES.has(split.state))) {
    result.statusText = 'Amazon 返回了未识别的处理状态，需继续核对';
    return result;
  }
  if (splits.some(split => split.invalidCounts)) {
    result.statusText = 'Amazon 数量统计格式无效或超过支持范围，尚不能确认结果';
    return result;
  }
  if (splits.some(split => split.conflictingCounts)) {
    result.statusText = 'Amazon 的成功数量超过提交数量，统计存在冲突';
    return result;
  }
  if (states.has('IN_PROGRESS')) {
    result.status = 'PROCESSING';
    result.statusText = splits.length > 1 ? 'Amazon 仍有分段正在处理' : 'Amazon 正在处理';
  } else if (splits.every(split => FAILED_STATES.has(split.state))) {
    result.status = 'FAILED';
    result.statusText = states.size === 1 && states.has('REJECTED') ? 'Amazon 已拒绝处理' : 'Amazon 处理失败';
  } else if (states.has('ACTION_REQUIRED')) {
    result.statusText = 'Amazon 要求进一步处理，尚不能确认最终结果';
  } else if (states.size === 1 && states.has('SAVED_AS_DRAFTS')) {
    result.status = 'RECEIVED';
    result.statusText = 'Amazon 已保存为草稿，尚未确认商品处理完成';
  } else if (states.has('NO_DATA_FOUND')) {
    result.statusText = 'Amazon 未找到处理数据，尚不能确认结果';
  } else if (splits.length > 1) {
    // Source code does not establish whether split counts are disjoint. Do not
    // add them together or infer overall success from a potentially partial sum.
    result.statusText = splits.every(split => SUCCESS_STATES.has(split.state))
      ? 'Amazon 各分段已结束处理，整体数量尚不能确认'
      : 'Amazon 各分段结果不一致，需继续核对';
  } else if (SUCCESS_STATES.has(splits[0].state)) {
    const { submitted, success } = splits[0];
    if (submitted === null || success === null) {
      result.statusText = 'Amazon 已结束处理，但缺少完整数量统计';
    } else if (submitted === 0) {
      result.statusText = 'Amazon 已结束处理，但没有提交记录，尚不能确认商品处理成功';
    } else if (success === submitted) {
      result.status = 'COMPLETED';
      result.statusText = 'Amazon 已处理完成，全部提交记录处理成功';
    } else {
      result.status = 'COMPLETED_WITH_WARNINGS';
      result.statusText = 'Amazon 已结束处理，成功数量少于提交数量；具体失败及警告数量尚未提供';
    }
  }
  return result;
}
