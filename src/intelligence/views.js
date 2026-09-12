import fs from 'node:fs';
import path from 'node:path';
import { readCheckHistory, latestStoreSnapshots } from '../lib/dashboard-history.js';
import { readState, failure } from './store.js';
import { acceptance, fresh, matched } from './rules.js';

function newestVoc(rows,target) {
  for(const entry of rows) {
    const storeResults=entry.report.results.filter(r=>r.storeKey===target.storeKey);
    for(const r of storeResults) {
      const item=(r.items||[]).find(i=>i.asin===target.asin);
      if(item)return {result:r,item,at:entry.report.finishedAt||entry.report.startedAt};
    }
    if(storeResults.length)return {result:storeResults[0],item:null,at:entry.report.finishedAt||entry.report.startedAt};
  }
  return null;
}
export function ownHealth(outDir,targets,now=Date.now()) {
  const result={};
  const own=targets.filter(t=>t.role==='own');
  if(!own.length)return result;
  const asinStores=latestStoreSnapshots({outDir,checkId:'asin-health',now:new Date(now)});
  const vocHistory=readCheckHistory({outDir,checkId:'voc',now:new Date(now)}).reverse();
  for(const t of own) {
    const asinStore=asinStores.get(t.storeKey);
    const asinResult=asinStore?.results.find(r=>r.asin===t.asin&&(!r.market||r.market===t.market));
    const a=asinResult?{result:asinResult,at:asinResult.checkedAt||asinStore.report.finishedAt||asinStore.report.startedAt}:null;
    const v=newestVoc(vocHistory,t);
    let asin={status:'UNKNOWN',detail:'未取得新鲜的可信商品巡检',at:a?.at};
    if(a&&fresh(a.at,now)) {
      const r=a.result;
      if(r.verdictSource==='dom+text'&&r.metrics?.collectionStatus==='COMPLETE') {
        if(r.metrics.listingActive===false||r.metrics.hasCart===false)asin={status:'FAIL',detail:'自有商品不可售或无购物车',at:a.at};
        else if(r.ok===true&&r.metrics.listingActive===true&&r.metrics.hasCart===true)asin={status:'PASS',detail:'本平台双路巡检确认商品可售且有购物车',at:a.at};
      }
    }
    let voc={status:'UNKNOWN',detail:'未取得新鲜的该 ASIN 双路 VOC 记录',at:v?.at};
    if(v?.item&&fresh(v.at,now)) {
      const item=v.item;
      if(/^(Poor|Very Poor)$/i.test(String(item.cxHealth||''))||item.abnormalTrend===true)voc={status:'FAIL',detail:'该商品存在 VOC 质量风险',at:v.at};
      else if(item.detailStatus==='COMPLETE'&&item.detailComplete===true&&/^(Good|Very Good|Excellent|Fair)$/i.test(String(item.cxHealth||'')))voc={status:'PASS',detail:'该商品双路 VOC 记录未见当前异常',at:v.at};
    }
    result[t.id]={asin,voc};
  }
  return result;
}
export function comparisonGroups(targets,salesBaseline) {
  const groups=targets.filter(t=>t.role==='own'&&t.enabled).map(own=>{
    const baseline=salesBaseline?.storeKey===own.storeKey?salesBaseline.products.find(p=>p.asin===own.asin):null;
    const competitors=targets.filter(t=>t.role==='competitor'&&t.enabled&&t.storeKey===own.storeKey&&t.ownTargetId===own.id)
      .map(t=>({...t,specsMatch:matched(t,own)}))
      .sort((a,b)=>(b.stale?-1:b.latest?.salesTrend?.bucketValue??-1)-(a.stale?-1:a.latest?.salesTrend?.bucketValue??-1));
    return {own,baseline,competitors};
  });
  // Baseline units are comparable only inside its one store and fixed period.
  return groups.sort((a,b)=>a.own.storeKey.localeCompare(b.own.storeKey)||(b.baseline?.unitsOrdered??-1)-(a.baseline?.unitsOrdered??-1));
}
export function overview(outDir,stores,now=Date.now()) {
  const state=readState(outDir),health=ownHealth(outDir,state.targets,now);
  const targets=state.targets.map(t=>({...t,latest:state.latest[t.id]||null,pending:Object.keys(state.pending[t.id]||{}),stale:state.latest[t.id]?.targetVersion!==t.version||!fresh(state.latest[t.id]?.observedAt,now),assessment:acceptance(t,state,health,now),business:state.business[t.id]||null}));
  const events=state.events.slice().reverse().map(e=>{
    const target=targets.find(t=>t.id===e.targetId);
    const current=state.latest[e.targetId];
    const currentTrusted=current?.trusted?.[e.field]&&fresh(current.observedAt,now)&&current.contextKey===e.after.contextKey;
    const currentMatches=e.field==='price'?current?.priceCents===e.after.priceCents:current?.availability===e.after.availability;
    const actionable=e.lifecycle==='ACTIVE'&&currentTrusted&&currentMatches&&target?.enabled&&fresh(e.createdAt,now,72);
    return {...e,target:target?{id:target.id,asin:target.asin,label:target.label,productLine:target.productLine,role:target.role}:null,
      lifecycle:!fresh(e.createdAt,now,72)&&e.lifecycle==='ACTIVE'?'EXPIRED':e.lifecycle,actionable:!!actionable,assessment:target?.assessment||null};
  });
  const run=state.run?{...state.run}:null;
  if(run?.state==='RUNNING'&&!fresh(run.heartbeatAt,now,0.1)) {run.state='INTERRUPTED';run.message='工作者心跳过期，等待下次恢复';}
  return {ok:true,revision:state.revision,settings:state.settings,targets,events,request:state.request,run,
    salesBaseline:state.salesBaseline||null,comparisons:comparisonGroups(targets,state.salesBaseline),
    stores:stores.filter(s=>String(s.market).toUpperCase()==='US').map(s=>({key:s.key,name:s.name,market:s.market})),
    summary:{targets:targets.length,enabled:targets.filter(t=>t.enabled).length,unreviewed:events.filter(e=>e.review.status==='unreviewed').length,collectionGaps:targets.filter(t=>t.enabled&&(t.stale||!t.latest?.trusted?.availability||!t.latest?.trusted?.price)).length},
    policy:{market:'US',maxTargets:30,intervalHours:12,confirmationSamples:2,priceChangePercent:5,priceChangeUsd:1,crmIndependent:true}};
}
export function history(outDir,id,page=1) {
  if(!readState(outDir).targets.some(t=>t.id===id))throw failure('商品不存在',404);
  const dir=path.join(outDir,'intelligence','snapshots',id);
  let files=[];try {files=fs.readdirSync(dir).filter(n=>/^[0-9TZ]+-[a-f0-9-]+\.json$/.test(n)).sort().reverse();}catch(e){if(e.code!=='ENOENT')throw e;}
  const selected=Math.max(1,Number.isSafeInteger(page)?page:1),pageSize=20;
  const records=files.slice((selected-1)*pageSize,selected*pageSize).map(f=>{try{return JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));}catch{return {status:'CORRUPT',error:'历史记录损坏，未当成正常'};}});
  return {ok:true,records,page:selected,pageSize,total:files.length,pages:Math.max(1,Math.ceil(files.length/pageSize))};
}
