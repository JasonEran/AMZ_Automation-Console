#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireRunLock, releaseRunLock } from '../checks/run.js';
import { createZiniao } from '../lib/ziniao-factory.js';
import { loadConfig } from '../lib/config.js';
import { createLogger } from '../lib/log.js';
import { redactText } from '../lib/redact.js';
import { readState, mutateState, HOUR } from './store.js';
import { recordSnapshot } from './rules.js';
import { collectProduct } from './collector.js';

// Keep a buffer around the existing four business windows, including the
// window just elapsed (the timer may not have acquired its lease yet).
export function protectedWindow(now=Date.now()) {
  const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date(now));
  const minute=Number(p.find(x=>x.type==='hour').value)*60+Number(p.find(x=>x.type==='minute').value);
  return [480,680,930,1110].some(t=>minute>=t-20&&minute<=t+10);
}
export function nextTarget(state,now=Date.now()) {
  const enabled=state.targets.filter(t=>t.enabled);
  if(state.request) {
    const done=new Set(state.request.completed||[]),requested=state.request.targetIds||enabled.map(t=>t.id);
    return enabled.find(t=>requested.includes(t.id)&&!done.has(t.id))||null;
  }
  if(!state.settings.autoCollect)return null;
  return enabled.filter(t=>!state.latest[t.id]||now-Date.parse(state.latest[t.id].observedAt)>=12*HOUR)
    .sort((a,b)=>String(state.latest[a.id]?.observedAt||'').localeCompare(String(state.latest[b.id]?.observedAt||'')))[0]||null;
}
export async function runIntelligenceWorker({config,stores,logger,zn:provided,now=Date.now(),collect=collectProduct,windowCheck=protectedWindow}) {
  let state=readState(config.outDir),target=nextTarget(state,now);
  if(!target) {
    if(state.request)mutateState(config.outDir,s=>{if(s.request?.id===state.request.id)s.request=null;});
    return {processed:false,reason:'no-due-targets'};
  }
  const defer=reason=>{mutateState(config.outDir,s=>{s.run={...(s.run||{}),state:'DEFERRED',message:reason,updatedAt:new Date().toISOString()};});return {processed:false,reason};};
  if(windowCheck(now))return defer('邻近既有巡检窗口，保留任务等待下一次调度');
  let lease;
  try{lease=acquireRunLock({outDir:config.outDir,label:'intelligence'});}catch(e){if(e.code==='RUN_ALREADY_ACTIVE')return defer('巡检或上传正在使用店铺会话，已延后');throw e;}
  let storeId,zn,heartbeat,runId=randomUUID();
  try {
    state=readState(config.outDir);target=nextTarget(state,now);
    if(!target)return {processed:false,reason:'already-completed'};
    const store=stores.find(s=>s.key===target.storeKey&&String(s.market).toUpperCase()==='US'&&s.enabled!==false);
    if(!store)throw new Error('观察店铺未启用或站点不匹配');
    const requestId=state.request?.id;
    mutateState(config.outDir,s=>{s.run={id:runId,state:'RUNNING',targetId:target.id,asin:target.asin,startedAt:new Date().toISOString(),heartbeatAt:new Date().toISOString(),total:state.request?.targetIds?.length||1,completed:state.request?.completed?.length||0,message:`正在只读观察 ${target.asin}`};});
    heartbeat=setInterval(()=>{try{mutateState(config.outDir,s=>{if(s.run?.id===runId)s.run.heartbeatAt=new Date().toISOString();});}catch(e){logger?.warn?.('情报心跳保存失败');}},15000);heartbeat.unref();
    zn=provided||createZiniao({config,logger});
    const opened=await zn.storeOpen({id:store.id||undefined,name:store.id?undefined:store.name,market:'US',url:`https://www.amazon.com/dp/${target.asin}`,privacy:false,headless:false,timeoutMs:180000});
    storeId=opened.storeId;
    const snapshot=await collect({zn,storeId,target,config});
    const saved=recordSnapshot(config.outDir,target,snapshot);
    mutateState(config.outDir,s=>{
      const request=s.request?.id===requestId?s.request:null;
      if(request){request.completed=[...new Set([...(request.completed||[]),target.id])];if(!nextTarget(s,now))s.request=null;}
      s.run={...s.run,id:runId,state:snapshot.status==='COMPLETE'?'COMPLETED':'PARTIAL',heartbeatAt:new Date().toISOString(),finishedAt:new Date().toISOString(),completed:request?.completed?.length||1,
        message:saved.ignored?'档案在采集中变更，本次证据未计入基线':snapshot.status==='COMPLETE'?`${target.asin} 双路采样完成${s.request?'，其余商品将在后续调度采集':''}`:`${target.asin} 数据待核验：${snapshot.issues.join('；')}`};
    });
    logger?.info?.(`情报采样 ${target.asin}：${snapshot.status}`);
    return {processed:true,targetId:target.id,status:snapshot.status};
  }catch(e){
    const reason=redactText(e.message).slice(0,220);
    if(target)recordSnapshot(config.outDir,target,{observedAt:new Date().toISOString(),status:'ERROR',priceCents:null,availability:'UNKNOWN',trusted:{price:false,availability:false},issues:[reason],evidence:{suppressed:true},contextKey:null});
    mutateState(config.outDir,s=>{
      s.run={...s.run,id:runId,state:'PARTIAL',finishedAt:new Date().toISOString(),message:reason};
      if(s.request&&target){s.request.completed=[...new Set([...(s.request.completed||[]),target.id])];if(!nextTarget(s,now))s.request=null;}
    });
    logger?.warn?.(`情报采集待修复：${reason}`);return {processed:true,status:'ERROR'};
  }finally{
    clearInterval(heartbeat);
    try {if(storeId)await zn.storeClose(storeId);}catch(e){mutateState(config.outDir,s=>{s.run={...s.run,state:'PARTIAL',message:'紫鸟会话关闭失败，需检查环境后继续'};});logger?.warn?.('情报店铺会话关闭失败');}
    finally{releaseRunLock(lease);}
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const {config,stores}=loadConfig();
  try{await runIntelligenceWorker({config,stores,logger:createLogger({level:'info'})});}
  catch(e){console.error(redactText(e.message));process.exitCode=2;}
}
