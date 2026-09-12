import { createHash, randomUUID } from 'node:crypto';
import { atomicJson, mutateState, HOUR } from './store.js';
import path from 'node:path';

export const PRICE_CHANGE_PERCENT = 5;
export const PRICE_CHANGE_CENTS = 100;
export const STALE_HOURS = 36;
const valueOf=(s,f)=>f==='price'?s.priceCents:s.availability;
export const fresh=(at,now=Date.now(),hours=STALE_HOURS)=>Number.isFinite(Date.parse(at))&&Date.parse(at)<=now+60000&&now-Date.parse(at)<=hours*HOUR;
export function matched(target,own) {
  return !!(own?.enabled&&target.matchConfirmed&&target.storeKey===own.storeKey&&target.productLine===own.productLine
    && ['model','capacity','color','packCount'].every(k=>target[k]&&own[k]&&String(target[k]).toLowerCase()===String(own[k]).toLowerCase()));
}
export function acceptance(target,state,health={},now=Date.now()) {
  if(target.role==='own')return {status:'OBSERVATION',reasons:['自有商品观察'],conditions:[]};
  const own=state.targets.find(t=>t.id===target.ownTargetId&&t.role==='own');
  const conditions=[];
  const add=(key,label,status,detail,asOf=null)=>conditions.push({key,label,status,detail,asOf});
  add('match','规格匹配',matched(target,own)?'PASS':'UNKNOWN',matched(target,own)?'型号、容量、颜色与包装数量已人工确认一致':'尚未确认完整可比规格');
  if(!own)return {status:'PENDING',own:null,conditions,reasons:conditions.map(c=>c.detail)};
  const report=health[own.id]||{};
  add('health','自身商品状态',report.asin?.status||'UNKNOWN',report.asin?.detail||'未取得本平台该商品的可信巡检报告',report.asin?.at);
  add('voc','客户声音',report.voc?.status||'UNKNOWN',report.voc?.detail||'未取得本平台该商品的可信 VOC 记录',report.voc?.at);
  const b=state.business[own.id];
  const valid=b&&b.targetVersion===own.version&&fresh(b.asOf,now,b.validHours);
  add('inventory','库存条件',!valid||b.inventory===null||b.minimumInventory===null?'UNKNOWN':b.inventory>0&&b.inventory>=b.minimumInventory?'PASS':'FAIL',
    !valid?'库存快照缺失或过期':b.inventory===null||b.minimumInventory===null?'请填写可用库存及最低库存要求':`${b.inventory} 件 / 要求至少 ${b.minimumInventory} 件`,b?.asOf);
  const profitReady=valid&&b.basis&&['sellingPrice','unitCost','unitFees','minimumProfit'].every(k=>typeof b[k]==='number');
  const unitProfit=profitReady?Math.round((b.sellingPrice-b.unitCost-b.unitFees)*100)/100:null;
  add('profit','利润条件',!profitReady?'UNKNOWN':unitProfit>=b.minimumProfit?'PASS':'FAIL',
    profitReady?`按人工参数计算 USD ${unitProfit.toFixed(2)} / 要求至少 USD ${b.minimumProfit.toFixed(2)}`:'成本、费用、售价、口径或有效期尚不完整',b?.asOf);
  return {status:conditions.some(c=>c.status==='FAIL')?'UNMET':conditions.every(c=>c.status==='PASS')?'READY':'PENDING',own:{id:own.id,asin:own.asin,label:own.label},unitProfit,conditions,reasons:conditions.filter(c=>c.status!=='PASS').map(c=>c.detail)};
}
export function recordSnapshot(outDir,target,snapshot) {
  return mutateState(outDir,state=>{
    const current=state.targets.find(t=>t.id===target.id);
    if(!current||current.version!==target.version||!current.enabled)return {ignored:true};
    const prior=state.latest[target.id];
    if(prior&&Date.parse(prior.observedAt)>=Date.parse(snapshot.observedAt))return {ignored:true};
    snapshot={...snapshot,id:randomUUID(),targetId:target.id,targetVersion:target.version,observedAt:snapshot.observedAt||new Date().toISOString()};
    atomicJson(path.join(outDir,'intelligence','snapshots',target.id,`${snapshot.observedAt.replace(/[^0-9TZ]/g,'')}-${snapshot.id}.json`),snapshot);
    state.latest[target.id]=snapshot;
    state.baselines[target.id] ||= {};
    state.pending[target.id] ||= {};
    const made=[];
    for(const field of ['price','availability']) {
      const baseline=state.baselines[target.id][field];
      const pending=state.pending[target.id][field];
      if(!snapshot.trusted?.[field]) {delete state.pending[target.id][field];continue;}
      if(!baseline||baseline.contextKey!==snapshot.contextKey||baseline.targetVersion!==snapshot.targetVersion||!fresh(baseline.observedAt,Date.parse(snapshot.observedAt),72)) {
        state.baselines[target.id][field]=snapshot;delete state.pending[target.id][field];
        for(const e of state.events.filter(e=>e.targetId===target.id&&e.field===field&&e.lifecycle==='ACTIVE')) {e.lifecycle='EXPIRED';e.lifecycleReason='观察环境、配置或时间连续性变化';}
        continue;
      }
      const before=valueOf(baseline,field),after=valueOf(snapshot,field);
      const changed=field==='price'?Math.abs(after-before)>=PRICE_CHANGE_CENTS&&Math.abs(after-before)/before*100>=PRICE_CHANGE_PERCENT:before!==after;
      if(!changed) {
        state.baselines[target.id][field]=snapshot; delete state.pending[target.id][field]; continue;
      }
      const fingerprint=createHash('sha256').update(JSON.stringify([snapshot.contextKey,target.version,field,before,after])).digest('hex');
      // Separate successful observations are required; DOM/text are two parsing paths, not two observations.
      if(!pending||pending.fingerprint!==fingerprint||!fresh(pending.after.observedAt,Date.parse(snapshot.observedAt),36)) {
        state.pending[target.id][field]={fingerprint,before:baseline,after:snapshot};continue;
      }
      if(Date.parse(snapshot.observedAt)-Date.parse(pending.after.observedAt)<60000)continue;
      const type=field==='price'?(after>before?'PRICE_UP':'PRICE_DOWN'):(after==='UNAVAILABLE'?'UNAVAILABLE':'AVAILABLE');
      for(const e of state.events.filter(e=>e.targetId===target.id&&e.field===field&&e.lifecycle==='ACTIVE')) {e.lifecycle='SUPERSEDED';e.lifecycleReason='已确认后续变化';}
      const event={id:randomUUID(),targetId:target.id,field,type,lifecycle:'ACTIVE',createdAt:snapshot.observedAt,before:baseline,after:snapshot,confirmation:{firstAt:pending.after.observedAt,secondAt:snapshot.observedAt},review:{version:0,status:'unreviewed',note:''},reviewHistory:[]};
      state.events.push(event);made.push(event);
      state.baselines[target.id][field]=snapshot;delete state.pending[target.id][field];
    }
    // Historical events are archived before trimming the hot index; snapshots remain independently readable.
    while(state.events.length>2000){const event=state.events.shift();atomicJson(path.join(outDir,'intelligence','archive',`${event.id}.json`),event);}
    return {snapshot,events:made};
  });
}
