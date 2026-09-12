import { CHECKS } from '../checks/registry.js';

/** Fixed, read-only CRM views. All response values enter the DOM as text. */
export const CRM_PORTAL_STYLE = `
:root{color-scheme:light;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#182b42;background:#f3f6fa;font-synthesis:none}
*{box-sizing:border-box}body{margin:0}button,select{font:inherit}button,select,a{touch-action:manipulation}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}button:focus-visible,select:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid #80b5f4;outline-offset:3px}
.shell{max-width:1180px;margin:auto;padding:28px 24px 48px}.topbar,.row,.tabs,.pager{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.topbar{justify-content:space-between;margin-bottom:28px}.brand{font-size:14px;font-weight:750;letter-spacing:.08em;color:#345270}.muted{color:#62758b;font-size:13px;line-height:1.65}.intro{margin-bottom:22px}.eyebrow{color:#426584;font-size:12px;letter-spacing:.12em;margin:0 0 10px}h1{font-size:28px;letter-spacing:-.04em;margin:0 0 8px}h2{font-size:19px;margin:0 0 14px}h3{font-size:15px;margin:0 0 10px}p{line-height:1.7;margin:8px 0}button{border:1px solid #cdd8e5;border-radius:8px;background:#fff;color:#263d58;padding:9px 14px}button:hover:enabled{background:#edf4fd;border-color:#89afd9}.primary{background:#245f9f;color:white;border-color:#245f9f}.primary:hover:enabled{background:#174c87}.panel{background:#fff;border:1px solid #dfe6ef;border-radius:12px;padding:22px;margin:18px 0}.tabs{border-bottom:1px solid #d7e1ed;gap:24px}.tabs button{border:0;border-radius:0;background:transparent;padding:12px 0;color:#62758b;font-weight:650}.tabs button[aria-selected=true]{color:#195a9d;border-bottom:3px solid #2c6fb5}.notice{border:1px solid #bad0e8;background:#eff6ff;color:#294e78;border-radius:8px;padding:12px 16px;margin:14px 0;line-height:1.65}.error{background:#fff4f2;border-color:#efc7c0;color:#913f36}.toolbar{display:flex;flex-wrap:wrap;align-items:end;gap:16px}.field{display:grid;gap:7px;min-width:180px;flex:1}.field label{font-size:13px;font-weight:650}.field select{width:100%;border:1px solid #ccd8e4;background:white;border-radius:7px;padding:10px;color:#243d58}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:16px}.check-card{border:1px solid #dfe6ef;border-radius:9px;padding:17px;min-width:0}.check-card button{margin-top:8px;font-size:12px;padding:6px 10px}.badge{display:inline-block;border-radius:5px;padding:3px 8px;font-size:12px;font-weight:650;background:#eef2f6;color:#526880}.badge.ok{background:#e7f4ec;color:#246540}.badge.warn{background:#fff1d9;color:#946006}.badge.bad{background:#fce8e6;color:#a44239}.badge.unknown{background:#eeeafa;color:#665091}.badge.stale{background:#f1ece7;color:#805b3a}.status-line{margin:10px 0 6px;overflow-wrap:anywhere}.time{font-size:12px;color:#657a90;line-height:1.7}.table-wrap{overflow:auto;margin:12px 0}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:10px;border-bottom:1px solid #e8edf3;vertical-align:top;overflow-wrap:anywhere}th{font-weight:650;color:#536b85;background:#f7f9fc}td:first-child{width:190px;color:#536b85}.record{border:1px solid #dfe6ef;border-radius:8px;margin:12px 0}.record>summary{cursor:pointer;padding:15px;font-weight:600;line-height:1.6;overflow-wrap:anywhere}.record-body{padding:0 15px 15px}.record summary .badge{margin-left:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:520px;overflow:auto;background:#f5f7fa;padding:14px;border-radius:8px;font-size:12px;line-height:1.7;color:#344c67}.pager{justify-content:flex-end;font-size:13px;color:#5b728c;margin-top:14px}.empty{padding:26px 8px;color:#647a91;text-align:center}.dev{font-size:13px;color:#657a90;margin-top:24px}.dev summary{cursor:pointer}.dev a{color:#2865a5}.foot{font-size:12px;color:#7a8da2;margin-top:22px;line-height:1.8}[hidden]{display:none!important}.sso{max-width:480px;margin:15vh auto;padding:26px}.sso .panel{padding:30px}
@media(max-width:760px){.shell{padding:20px 15px 32px}.grid{grid-template-columns:1fr 1fr}.panel{padding:16px}h1{font-size:24px}.field{min-width:150px}td:first-child{width:110px}}@media(max-width:480px){.grid{grid-template-columns:1fr}.topbar{margin-bottom:20px}.toolbar{display:grid;width:100%}.pager{justify-content:space-between}}
`;

export const CRM_PORTAL_SCRIPT = String.raw`
(function () {
  'use strict';
  var CHECKS = ${JSON.stringify(CHECKS.map(check => [check.id, check.title]))};
  var LABELS = {status:'状态',severity:'级别',ok:'判定正常',businessStatus:'业务状态',collectionStatus:'证据完整性',
    asin:'ASIN',parentAsin:'关联 ASIN',rating:'评分',date:'发表日期',dateKey:'日期',summary:'摘要',reason:'原因',
    reasons:'判定原因',notes:'说明',cxHealth:'客户体验',ncxRatePct:'买家不满意率（%）',returnRatePct:'退货率（%）',
    ncxOrders:'买家不满意订单数',totalOrders:'订单总数',returnReasons:'退货原因',customerIssues:'客户问题',
    topNcxReason:'主要不满意原因',identifier:'记录标识',itemKey:'稳定记录键',detailComplete:'详情完整',
    checkedAt:'记录的检查时间',collectedAt:'采集参考时间',generatedAt:'接口生成时间',stale:'数据过期',
    runId:'运行标识',storeKey:'店铺标识',market:'站点',confidence:'可信度',verdictSource:'判定证据来源',
    collectionDate:'采集日期',reportStartedAt:'批次开始',reportFinishedAt:'批次结束',timestampValid:'时间有效',
    timeSource:'采集时间来源',ageMs:'数据年龄（毫秒）',runIdSource:'运行标识来源',snapshotId:'快照标识'};
  var STATUS = {UNKNOWN:'无法判定',PARTIAL_EVIDENCE:'证据不足',ERROR:'采集失败',LOGIN_REQUIRED:'会话待恢复',
    NEVER_RUN:'尚未运行',NOT_COVERED:'未覆盖',NOT_CONFIGURED:'未配置',SKIPPED:'未完成',OK:'正常',
    HEALTHY:'健康',CLEAR:'无当前异常',ALL_ON:'多数开启符合预期',ALL_OFF:'多数关闭符合预期',
    INACTIVE_LISTING:'非在售',LOW_REVIEW:'发现低星评价',TODAY_LOW_RATING:'当天低分反馈',POOR_CX:'客户体验异常'};
  var state = {session:null,store:null,checks:[],view:'results',checkId:'store-health',runId:'',runPage:1,
    runPagination:null,page:1,pagination:null,snapshotId:'',serial:0,runSerial:0,expired:false,lastJson:null};
  var $ = function (id) { return document.getElementById(id); };
  function element(tag, text, cls) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (cls) node.className = cls;
    return node;
  }
  function clear(node) { node.replaceChildren(); }
  function formatTime(value) {
    if (!value) return '未提供';
    var date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', {
      timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false
    }).format(date) : '时间待核验';
  }
  function titleFor(id) { var entry=CHECKS.find(function (item) { return item[0]===id; }); return entry ? entry[1] : '检查项'; }
  function scalar(value) {
    if (value === null || value === undefined || value === '') return '未提供';
    if (typeof value === 'boolean') return value ? '是' : '否';
    return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }
  function showError(message) { $('error').textContent=message; $('error').hidden=false; }
  function hideError() { $('error').hidden=true; $('error').textContent=''; }
  function expire(message) {
    state.expired=true; state.serial++; state.runSerial++;
    showError(message || '会话已失效，请退出本页并从 CRM 重新进入。');
    document.querySelectorAll('[data-read-control]').forEach(function (node) { node.disabled=true; });
    $('records').replaceChildren(); $('checks').replaceChildren(); $('rawJson').textContent=''; $('dataLoading').hidden=true;
  }
  async function request(url, options) {
    var response;
    try { response=await fetch(url,Object.assign({credentials:'same-origin',headers:{Accept:'application/json'}},options||{})); }
    catch (_) { throw new Error('连接暂时中断，未取得新数据。请稍后刷新；仍失败时退出并从 CRM 重新进入。'); }
    if (response.status===401 || response.status===403) {
      expire(); throw new Error('会话已失效或超出授权范围，请退出本页并从 CRM 重新进入。');
    }
    if (response.status===503) {
      expire('服务暂不可用，请退出本页，稍后从 CRM 重新进入。');
      throw new Error('服务暂不可用，请退出本页，稍后从 CRM 重新进入。');
    }
    if (!/^application\/(?:problem\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')) {
      expire('未收到有效接口响应，请退出本页并从 CRM 重新进入。');
      throw new Error('未收到有效接口响应，请退出本页并从 CRM 重新进入。');
    }
    var body;
    try { body=await response.json(); }
    catch (_) { expire('接口响应不完整，请退出本页并从 CRM 重新进入。'); throw new Error('接口响应不完整，请退出本页并从 CRM 重新进入。'); }
    if (response.status===409) {
      state.snapshotId=''; state.page=1;
      throw new Error(body.code==='REPORT_CONFLICT'
        ? '已保存的报告副本存在冲突，当前数据不可作为正常依据。请联系维护人员核对。'
        : '报告快照已变化。请点击“刷新已有数据”重新读取第 1 页，避免混用不同快照。');
    }
    if (response.status===429) {
      var retry=Number(response.headers.get('retry-after'));
      throw new Error('读取频率过高，请'+(Number.isFinite(retry)&&retry>0?Math.ceil(retry)+' 秒后':'稍后')+'再刷新。');
    }
    if (!response.ok || !body || !Object.prototype.hasOwnProperty.call(body,'data')) {
      throw new Error('暂时无法读取所选数据，请重试；仍失败时从 CRM 重新进入。');
    }
    return body;
  }
  function recordJson(body) {
    state.lastJson=body; $('rawJson').textContent=JSON.stringify(body,null,2);
    $('generatedAt').textContent='接口生成：'+formatTime(body.metadata && body.metadata.generatedAt)+'（北京时间）';
    var ignored=body.metadata && body.metadata.ignoredReports;
    $('coverageWarning').hidden=!(ignored>0);
    $('coverageWarning').textContent=ignored>0?'所读检查目录有 '+ignored+' 份报告无法采用，历史覆盖不完整；当前显示不能代表全部保存报告。请联系维护人员核对。':'';
  }
  function classification(result) {
    result=result||{};
    var statuses=Array.isArray(result.status)?result.status:[result.status];
    var rows=Array.isArray(result.results)?result.results:[result];
    var stale=result.stale===true || rows.some(function (r) { return r.source && r.source.stale===true; });
    var incomplete=rows.some(function (r) {
      return r.collectionStatus==='PARTIAL_EVIDENCE' || (r.evidence && r.evidence.bothAvailable===false);
    });
    if (stale) return ['数据已过期','stale'];
    if (incomplete || statuses.some(function (s) { return /UNKNOWN|PARTIAL|ERROR|LOGIN_REQUIRED|NOT_CONFIGURED/.test(s||''); }) || result.severity==='ERROR') return ['采集待核验','unknown'];
    if (!statuses.some(Boolean) || statuses.some(function (s) { return /NEVER_RUN|NOT_COVERED|SKIPPED/.test(s||''); })) return ['未完成',''];
    if (result.severity==='CRITICAL') return ['业务待处理','bad'];
    if (result.severity==='WARN') return ['需要关注','warn'];
    if (result.severity==='OK' && rows.length && rows.every(function (r) { return r.ok===true; })) return ['正常','ok'];
    return ['请核对证据','unknown'];
  }
  function badge(result) { var c=classification(result); return element('span',c[0],'badge '+c[1]); }
  function fieldsTable(value) {
    var table=element('table'), body=element('tbody');
    Object.keys(value||{}).forEach(function (key) {
      var row=element('tr'); row.append(element('td',LABELS[key]||key),element('td',scalar(value[key]))); body.append(row);
    });
    table.append(body); var wrap=element('div',null,'table-wrap'); wrap.append(table); return wrap;
  }
  function detailsBlock(label,value) {
    var details=element('details'); details.append(element('summary',label));
    if (value && typeof value==='object' && !Array.isArray(value)) details.append(fieldsTable(value));
    else details.append(element('pre',scalar(value)));
    return details;
  }
  function renderResults(body) {
    clear($('checks')); if (state.view==='results') recordJson(body);
    var data=body.data||{}; state.checks=Array.isArray(data.checks)?data.checks:[];
    if (data.store) renderStore(data.store);
    CHECKS.forEach(function (pair,index) {
      var check=state.checks.find(function (entry) { return entry.checkId===pair[0]; }) || {checkId:pair[0],status:['NEVER_RUN'],results:[]};
      var card=element('article',null,'check-card'); card.append(element('h3',String(index+1).padStart(2,'0')+' · '+pair[1]),badge(check));
      var statuses=Array.isArray(check.status)?check.status:[check.status];
      card.append(element('p',statuses.filter(Boolean).map(function (s) { return (STATUS[s]||s)+' · '+s; }).join(' / ')||'无可用记录','status-line'));
      var rows=Array.isArray(check.results)?check.results:[];
      var times=rows.map(function (r) { return r.source && (r.source.checkedAt||r.source.collectedAt); }).filter(Boolean).sort();
      card.append(element('div','最近检查：'+formatTime(times.at(-1)),'time'));
      card.append(element('div','本店结果：'+(Number.isFinite(check.resultCount)?check.resultCount:rows.length)+' 条','time'));
      if (rows.length) {
        var details=element('details'); details.append(element('summary','判定依据'));
        rows.forEach(function (row) {
          var section=element('div');
          if (row.asin) section.append(element('p',row.asin));
          section.append(badge(row));
          section.append(element('p',Array.isArray(row.reasons)?row.reasons.join('；'):'详见结构化结果。','muted'));
          section.append(element('p','记录的检查时间：'+formatTime(row.source && row.source.checkedAt),'time'));
          if (row.metrics) section.append(detailsBlock('指标',row.metrics));
          details.append(section);
        });
        card.append(details);
      }
      var button=element('button','查看完整数据'); button.type='button'; button.dataset.readControl='';
      button.addEventListener('click',function () { if (!state.expired) { state.checkId=pair[0]; $('checkSelect').value=pair[0]; setView('data'); changeCheck(); } });
      card.append(button); $('checks').append(card);
    });
  }
  function renderStore(store) {
    if (!store || store.storeKey!==state.session.storeKey) return;
    state.store=store;
    $('storeName').textContent=store.storeName||store.storeKey;
    $('storeMeta').textContent='店铺 '+store.storeKey+(store.market?' · '+store.market:'')+' · 当前会话仅可读取本店';
  }
  function basePath() { return '/api/crm/v1/stores/'+encodeURIComponent(state.session.storeKey); }
  function checkPath() { return basePath()+'/checks/'+encodeURIComponent(state.checkId); }
  function paginationText(p) {
    return p ? '第 '+p.page+' / '+Math.max(1,p.pages||0)+' 页 · 共 '+(p.total||0)+' 条' : '暂无分页数据';
  }
  function updatePager() {
    $('pageLabel').textContent=paginationText(state.pagination);
    $('previousPage').disabled=state.expired || !state.pagination || state.page<=1;
    $('nextPage').disabled=state.expired || !state.pagination || state.pagination.hasMore!==true;
  }
  function renderRecords(body) {
    clear($('records')); if (state.view==='data') recordJson(body);
    state.pagination=body.pagination||null; state.snapshotId=(body.metadata && body.metadata.snapshotId)||state.snapshotId;
    $('dataDescription').textContent=titleFor(state.checkId)+' · '+(body.metadata && body.metadata.runId || state.runId)+' · 本次运行已保存的数据';
    var rows=Array.isArray(body.data)?body.data:[];
    if (!rows.length) $('records').append(element('p','当前页没有已保存记录。空列表不表示检查正常。','empty'));
    rows.forEach(function (row,index) {
      var result=row.result||{}, item=row.item||{}, details=element('details',null,'record');
      var type={ 'check-result':'检查结果','business-item':'业务记录','voc-asin':'VOC 商品','voc-record':'VOC 记录' }[row.recordType]||'记录';
      var asin=row.parentAsin||item.asin||result.asin;
      var heading=element('summary',type+(asin?' · '+asin:'')+' · '+((state.page-1)*100+index+1)); heading.append(badge(result)); details.append(heading);
      if (row.recordType==='voc-asin') details.open=true;
      var content=element('div',null,'record-body');
      content.append(element('p','记录的检查时间：'+formatTime(result.source && result.source.checkedAt)+'；采集参考时间：'+formatTime(result.source && result.source.collectedAt)+'（来源见下方）','time'));
      content.append(fieldsTable({status:result.status,severity:result.severity,businessStatus:result.businessStatus,collectionStatus:result.collectionStatus,verdictSource:result.verdictSource}));
      if (Array.isArray(result.reasons) && result.reasons.length) content.append(element('p',result.reasons.join('；')));
      if (row.item) content.append(fieldsTable(row.item));
      if (result.metrics) content.append(detailsBlock('检查指标',result.metrics));
      if (result.source) content.append(detailsBlock('采集时间与来源',result.source));
      if (result.evidence) content.append(detailsBlock('证据完整性',result.evidence));
      var extra={};
      Object.keys(result).forEach(function (key) {
        if (!['status','severity','businessStatus','collectionStatus','verdictSource','reasons','metrics','source','evidence'].includes(key)) extra[key]=result[key];
      });
      if (Object.keys(extra).length) content.append(detailsBlock('其他已保存字段',extra));
      if (row.reviewPages) content.append(detailsBlock('评价分页证据记录',row.reviewPages));
      details.append(content); $('records').append(details);
    });
    updatePager();
  }
  async function loadData() {
    var serial=++state.serial;
    if (!state.runId || state.expired) { clear($('records')); state.pagination=null; updatePager(); return; }
    hideError(); clear($('records')); $('rawJson').textContent=''; $('dataLoading').hidden=false;
    $('previousPage').disabled=true; $('nextPage').disabled=true;
    var query=new URLSearchParams({runId:state.runId,page:String(state.page),pageSize:'100'});
    if (state.snapshotId) query.set('snapshotId',state.snapshotId);
    try { var body=await request(checkPath()+'/data?'+query); if (serial===state.serial && !state.expired) renderRecords(body); }
    catch (error) { if (serial===state.serial && !state.expired) { clear($('records')); $('rawJson').textContent=''; state.pagination=null; updatePager(); showError(error.message); } }
    finally { if (serial===state.serial) $('dataLoading').hidden=true; }
  }
  async function loadRuns() {
    var serial=++state.runSerial; state.serial++; clear($('records')); clear($('runSelect')); state.runId='';
    $('rawJson').textContent=''; $('dataDescription').textContent='';
    state.pagination=null; updatePager(); hideError(); $('runSelect').disabled=true;
    try {
      var body=await request(checkPath()+'/runs?page='+state.runPage+'&pageSize=50');
      if (serial!==state.runSerial || state.expired) return;
      var runs=Array.isArray(body.data)?body.data:[]; state.runPagination=body.pagination||null;
      runs.forEach(function (run) {
        var option=element('option',formatTime(run.finishedAt||run.startedAt)+' · '+run.runId); option.value=run.runId; option.dataset.snapshotId=run.snapshotId||''; $('runSelect').append(option);
      });
      $('runPageLabel').textContent=paginationText(state.runPagination);
      $('previousRuns').disabled=state.runPage<=1; $('nextRuns').disabled=!state.runPagination || state.runPagination.hasMore!==true;
      if (runs.length) { state.runId=runs[0].runId; state.page=1; state.snapshotId=runs[0].snapshotId||''; $('runSelect').disabled=false; await loadData(); }
      else { $('records').append(element('p','此检查项尚无可用运行记录，不能据此判为正常。','empty')); recordJson(body); }
    } catch(error) { if (serial===state.runSerial && !state.expired) showError(error.message); }
  }
  function setView(view) {
    state.view=view==='data'?'data':'results';
    $('resultsView').hidden=state.view!=='results'; $('dataView').hidden=state.view!=='data';
    $('resultsTab').setAttribute('aria-selected',String(state.view==='results'));
    $('dataTab').setAttribute('aria-selected',String(state.view==='data'));
  }
  function changeCheck() { state.runPage=1; state.page=1; state.snapshotId=''; loadRuns(); }
  async function loadResults() {
    hideError(); clear($('checks')); $('rawJson').textContent='';
    try { var body=await request(basePath()+'/results'); if (!state.expired) renderResults(body); }
    catch(error) { if (!state.expired) showError(error.message); }
  }
  $('resultsTab').addEventListener('click',function () { if (!state.expired) { setView('results'); loadResults(); } });
  $('dataTab').addEventListener('click',function () { if (!state.expired) { setView('data'); if (state.runId) loadData(); else loadRuns(); } });
  $('checkSelect').addEventListener('change',function () { state.checkId=$('checkSelect').value; changeCheck(); });
  $('runSelect').addEventListener('change',function () { state.runId=$('runSelect').value; state.page=1; state.snapshotId=$('runSelect').selectedOptions[0].dataset.snapshotId||''; loadData(); });
  $('previousPage').addEventListener('click',function () { if (state.page>1) { state.page--; loadData(); } });
  $('nextPage').addEventListener('click',function () { if (state.pagination && state.pagination.hasMore) { state.page++; loadData(); } });
  $('previousRuns').addEventListener('click',function () { if (state.runPage>1) { state.runPage--; loadRuns(); } });
  $('nextRuns').addEventListener('click',function () { if (state.runPagination && state.runPagination.hasMore) { state.runPage++; loadRuns(); } });
  $('refresh').addEventListener('click',function () {
    if (state.expired) return; hideError();
    if (state.view==='data') { state.snapshotId=''; state.page=1; loadRuns(); } else loadResults();
  });
  $('logout').addEventListener('click',async function () {
    $('logout').disabled=true;
    try {
      var response=await fetch('/crm/logout',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:'{}'});
      if (!response.ok) throw new Error('退出未完成，请关闭本页并从 CRM 重新进入。');
      expire('已退出。请关闭本页；再次查看时从 CRM 重新进入。');
    } catch(error) { showError('退出未完成，请关闭本页并从 CRM 重新进入。'); $('logout').disabled=false; }
  });
  CHECKS.forEach(function (pair) { var option=element('option',pair[1]); option.value=pair[0]; $('checkSelect').append(option); });
  document.querySelectorAll('[data-read-control]').forEach(function (node) { node.disabled=true; });
  (async function () {
    try {
      var session=await request('/crm/session'); state.session=session.data;
      if (!state.session || typeof state.session.storeKey!=='string' || !state.session.storeKey) throw new Error('当前身份无有效店铺范围，请退出并从 CRM 重新进入。');
      if (CHECKS.some(function (pair) { return pair[0]===state.session.checkId; })) state.checkId=state.session.checkId;
      $('checkSelect').value=state.checkId; renderStore({storeKey:state.session.storeKey});
      $('sessionExpiry').textContent='会话有效至 '+formatTime(state.session.expiresAt)+'（北京时间）';
      var stores=await request('/api/crm/v1/stores');
      var store=Array.isArray(stores.data)?stores.data.find(function (entry) { return entry.storeKey===state.session.storeKey; }):null;
      if (store) renderStore(store);
      setView(state.session.view==='data'?'data':'results');
      if (state.view==='data') await loadRuns(); else await loadResults();
      if (!state.expired) {
        ['resultsTab','dataTab','refresh','checkSelect'].forEach(function (id) { $(id).disabled=false; });
      }
      $('initialLoading').hidden=true;
    } catch(error) { $('initialLoading').hidden=true; expire(error.message); }
  })();
})();
`;

export const CRM_PORTAL_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>店铺监测 · CRM</title><style>${CRM_PORTAL_STYLE}</style></head>
<body><main class="shell">
<header class="topbar"><div class="brand">AMZ GUARD <span class="muted">/ CRM 只读监测</span></div><div class="row"><span id="sessionExpiry" class="muted">正在确认授权</span><button id="logout" type="button">退出</button></div></header>
<section class="intro"><p class="eyebrow">单店授权工作区</p><h1 id="storeName">店铺监测</h1><p id="storeMeta" class="muted">正在读取店铺范围</p></section>
<div id="error" class="notice error" role="alert" hidden></div><div id="initialLoading" class="notice" role="status">正在读取已有监测数据…</div>
<div id="coverageWarning" class="notice" role="status" hidden></div>
<div class="row"><div class="tabs" role="tablist" aria-label="查看内容"><button id="resultsTab" type="button" role="tab" aria-controls="resultsView" aria-selected="true" data-read-control>监测结果</button><button id="dataTab" type="button" role="tab" aria-controls="dataView" aria-selected="false" data-read-control>完整数据</button></div><button id="refresh" type="button" data-read-control>刷新已有数据</button></div>
<p class="muted">刷新只读取已保存报告。判断新鲜度请看实际检查时间；接口生成时间仅表示本次响应生成时间。</p><p id="generatedAt" class="time"></p>
<section id="resultsView" role="tabpanel" aria-labelledby="resultsTab"><div id="checks" class="grid"></div></section>
<section id="dataView" role="tabpanel" aria-labelledby="dataTab" hidden><div class="panel"><div class="toolbar"><div class="field"><label for="checkSelect">检查项</label><select id="checkSelect" data-read-control></select></div><div class="field"><label for="runSelect">运行记录（北京时间）</label><select id="runSelect" data-read-control disabled></select></div></div><div class="pager"><button id="previousRuns" type="button" data-read-control disabled>较新批次</button><span id="runPageLabel">暂无运行记录</span><button id="nextRuns" type="button" data-read-control disabled>较早批次</button></div></div>
<div class="panel"><h2>已保存的完整数据</h2><p id="dataDescription" class="muted"></p><p class="muted">完整数据按本次运行实际保存的字段分页展示，保留证据不足、未知与过期状态，不代表 Amazon 当前实时状态。VOC 按商品和关联记录展开。</p><p id="dataLoading" class="muted" role="status" hidden>正在读取此页…</p><div id="records"></div><div class="pager"><button id="previousPage" type="button" data-read-control disabled>上一页</button><span id="pageLabel">暂无分页数据</span><button id="nextPage" type="button" data-read-control disabled>下一页</button></div></div></section>
<details class="dev"><summary>查看当前响应 JSON</summary><p><a href="/api/crm/v1/openapi.json" target="_blank" rel="noopener noreferrer">接口定义</a></p><pre id="rawJson"></pre></details>
<p class="foot">此页面仅展示当前授权店铺的九项巡检。业务异常与采集异常分别保留；没有记录、证据不足或数据过期都不能视为正常。</p>
</main><script>${CRM_PORTAL_SCRIPT}</script></body></html>`;

export const CRM_SSO_SCRIPT = String.raw`
(function () {
  'use strict';
  var fragment=window.location.hash;
  window.history.replaceState(null,'','/crm/sso');
  var ticket=new URLSearchParams(fragment.slice(1)).get('ticket')||'';
  fragment='';
  var message=document.getElementById('ssoMessage');
  async function exchange() {
    if (!ticket || ticket.length>8192) { ticket=''; message.textContent='缺少有效授权，请关闭本页并从 CRM 重新进入。'; return; }
    try {
      var body=JSON.stringify({ticket:ticket}); ticket='';
      var response=await fetch('/crm/sso/exchange',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:body});
      body='';
      if (!response.ok || !(response.headers.get('content-type')||'').toLowerCase().includes('application/json')) throw new Error('exchange failed');
      var result=await response.json();
      if (!result || result.error || !result.data || result.data.location!=='/crm/') throw new Error('exchange failed');
      window.location.replace('/crm/');
    } catch (_) { ticket=''; message.textContent='授权无效、已使用或已过期。请关闭本页并从 CRM 重新进入。'; }
  }
  exchange();
})();
`;

export const CRM_SSO_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>正在验证 CRM 授权</title><style>${CRM_PORTAL_STYLE}</style></head><body><main class="sso"><section class="panel"><p class="eyebrow">AMZ GUARD / CRM</p><h1>正在验证访问授权</h1><p id="ssoMessage" role="status">请稍候，正在进入授权店铺的只读监测页面…</p></section></main><script>${CRM_SSO_SCRIPT}</script></body></html>`;
