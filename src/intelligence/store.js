import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const HOUR = 3600000;
export function failure(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
export function initialState() {
  return { schemaVersion: 1, revision: 0, settings: { autoCollect: false }, targets: [], business: {}, latest: {}, baselines: {}, pending: {}, events: [], audit: [], request: null, run: null };
}
export function statePath(outDir) { return path.join(outDir, 'state', 'intelligence', 'state.json'); }
export function readState(outDir) {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(outDir), 'utf8'));
    if (value.schemaVersion !== 1 || !Array.isArray(value.targets) || !Array.isArray(value.events) || !value.latest || !value.baselines || !value.business || !value.settings || !value.pending) throw new Error('schema');
    return value;
  } catch (e) {
    if (e.code === 'ENOENT') return initialState();
    throw failure('情报数据无法读取，请检查存储；已停止写入，未重置历史。', 503);
  }
}
export function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', {mode:0o600}); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch(e) { return e.code === 'EPERM'; } }
export function mutateState(outDir, fn) {
  const file = statePath(outDir), lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), {recursive:true,mode:0o700});
  for (let attempt=0; ; attempt++) {
    try { fs.writeFileSync(lock, JSON.stringify({pid:process.pid}), {flag:'wx',mode:0o600}); break; }
    catch(e) {
      if(e.code !== 'EEXIST') throw e;
      let record; try { record=JSON.parse(fs.readFileSync(lock,'utf8')); } catch { throw failure('情报存储锁待检查',503); }
      if(attempt || !Number.isSafeInteger(record.pid) || record.pid<1 || alive(record.pid)) throw failure('情报正在保存，请稍后重试',409);
      try { fs.unlinkSync(lock); } catch(e2) { if(e2.code!=='ENOENT')throw e2; }
    }
  }
  try {
    const state=readState(outDir), result=fn(state);
    state.revision++; state.updatedAt=new Date().toISOString();
    atomicJson(file,state); return result;
  } finally { fs.unlinkSync(lock); }
}
export function text(value, name, max=120, required=false) {
  if(value != null && typeof value !== 'string') throw failure(`${name}格式无效`);
  const s=String(value??'').trim();
  if((required&&!s)||s.length>max||/[\u0000-\u001f\u007f]/.test(s)) throw failure(`${name}长度或内容无效`);
  return s;
}
function numeric(v,name,{min=0,max=1000000,integer=false,nullable=true}={}) {
  if(v==null||v==='') { if(nullable)return null; throw failure(`请填写${name}`); }
  if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||(integer&&!Number.isInteger(v)))throw failure(`${name}数值无效`);
  return v;
}
function audit(state, action, targetId, actor, before, after) {
  state.audit ||= [];
  state.audit.push({id:randomUUID(),action,targetId,by:actor,at:new Date().toISOString(),before:before||null,after});
  state.audit=state.audit.slice(-500);
}
export function saveTarget(outDir, payload, stores, actor, id=null) {
  return mutateState(outDir, state => {
    const prev=id?state.targets.find(t=>t.id===id):null;
    if(id&&!prev)throw failure('商品档案不存在',404);
    if(prev&&payload.version!==prev.version)throw failure('档案已更新，请刷新后再保存',409);
    if(!prev&&state.targets.length>=30)throw failure('第一版最多维护 30 个观察商品');
    const storeKey=text(payload.storeKey,'店铺',64,true);
    const store=stores.find(s=>s.key===storeKey&&s.enabled!==false);
    if(!store||String(store.market||'').toUpperCase()!=='US')throw failure('第一版请选择已配置的美国站紫鸟店铺');
    const asin=text(payload.asin,'ASIN',10,true).toUpperCase();
    if(!/^[A-Z0-9]{10}$/.test(asin))throw failure('ASIN 必须是 10 位字母或数字');
    if(prev&&(prev.asin!==asin||prev.storeKey!==storeKey||prev.role!==payload.role))throw failure('ASIN、店铺和类型不能修改，请停用后另建档案');
    if(!['own','competitor'].includes(payload.role))throw failure('商品类型无效');
    if(payload.enabled!==false&&state.targets.some(t=>t.id!==id&&t.enabled&&t.asin===asin&&t.storeKey===storeKey))throw failure('该店铺会话已存在启用的此 ASIN，请先停用原档案',409);
    const target={id:prev?.id||randomUUID(),version:(prev?.version||0)+1,asin,market:'US',storeKey,role:payload.role,
      label:text(payload.label,'名称',160),productLine:text(payload.productLine,'产品线',80,true),
      model:text(payload.model,'兼容型号',100),capacity:text(payload.capacity,'容量/版本',80),color:text(payload.color,'颜色组合',80),
      packCount:numeric(payload.packCount,'包装数量',{min:1,max:1000,integer:true}),
      ownTargetId:text(payload.ownTargetId,'对应商品',36)||null,matchConfirmed:payload.matchConfirmed===true,
      enabled:payload.enabled!==false,createdAt:prev?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),updatedBy:actor};
    if(target.role==='own') { target.ownTargetId=null; target.matchConfirmed=false; }
    if(target.ownTargetId) {
      const own=state.targets.find(t=>t.id===target.ownTargetId&&t.role==='own'&&t.storeKey===target.storeKey);
      if(!own)throw failure('请选择同一店铺的自有对标商品');
    }
    audit(state,'target-saved',target.id,actor,prev,target);
    if(prev)state.targets[state.targets.indexOf(prev)]=target;else state.targets.push(target);
    delete state.baselines[target.id]; delete state.pending[target.id];
    for(const event of state.events.filter(e=>e.targetId===target.id&&e.lifecycle==='ACTIVE')) {event.lifecycle='EXPIRED';event.lifecycleReason='档案已修改，需重新建立基线';}
    return target;
  });
}
export function saveBusiness(outDir,id,payload,actor,now=Date.now()) {
  return mutateState(outDir,state=>{
    if(!state.targets.some(t=>t.id===id&&t.role==='own'))throw failure('自有商品不存在',404);
    const previous=state.business[id];
    if((previous?.version||0)!==payload.version)throw failure('经营参数已更新，请刷新',409);
    const asOf=text(payload.asOf,'数据截止时间',40,true), at=Date.parse(asOf);
    if(!Number.isFinite(at)||at>now+60000)throw failure('数据截止时间无效或在未来');
    const record={version:(previous?.version||0)+1,targetVersion:state.targets.find(t=>t.id===id).version,asOf:new Date(at).toISOString(),source:'manual',currency:'USD',
      validHours:numeric(payload.validHours,'有效小时数',{min:1,max:168,integer:true,nullable:false}),
      inventory:numeric(payload.inventory,'可用库存',{integer:true}),minimumInventory:numeric(payload.minimumInventory,'最低库存',{integer:true,min:1}),
      sellingPrice:numeric(payload.sellingPrice,'自身售价'),unitCost:numeric(payload.unitCost,'单位成本'),unitFees:numeric(payload.unitFees,'单位费用'),
      minimumProfit:numeric(payload.minimumProfit,'最低单位贡献利润'),
      basis:text(payload.basis,'成本费用口径',500),updatedAt:new Date(now).toISOString(),updatedBy:actor};
    audit(state,'business-saved',id,actor,previous,record);
    state.business[id]=record;return record;
  });
}
export function requestRun(outDir,actor) {
  return mutateState(outDir,state=>{
    if(!state.targets.some(t=>t.enabled))throw failure('请先添加并启用观察商品');
    if(state.request)return state.request;
    state.request={id:randomUUID(),requestedAt:new Date().toISOString(),requestedBy:actor,targetIds:state.targets.filter(t=>t.enabled).map(t=>t.id),completed:[]};return state.request;
  });
}
// Fixed-period selection evidence, separate from recurring public-page samples.
// Called by the read-only pilot setup after verifying the page evidence.
export function saveSalesBaseline(outDir,payload,stores,actor) {
  const storeKey=text(payload.storeKey,'店铺',64,true);
  if(!stores.some(s=>s.key===storeKey&&s.enabled!==false&&s.market==='US'))throw failure('试点店铺无效');
  const dates=['start','end'].map(k=>text(payload.period?.[k],'统计日期',10,true));
  if(dates.some(d=>!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d)||dates[0]>dates[1])throw failure('统计区间无效');
  if(!Number.isFinite(Date.parse(payload.observedAt))||Date.parse(payload.observedAt)>Date.now()+60000)throw failure('核验时间无效');
  if(!/^[a-f0-9]{64}$/.test(payload.evidenceSha256||''))throw failure('缺少业务报告文件校验值');
  if(!Array.isArray(payload.products)||!payload.products.length||payload.products.length>10000)throw failure('业务报告商品列表无效');
  const seen=new Set();
  const products=payload.products.map(p=>{
    const asin=text(p.asin,'ASIN',10,true);
    if(!/^[A-Z0-9]{10}$/.test(asin)||seen.has(asin))throw failure('业务报告存在无效或重复 ASIN');
    seen.add(asin);
    return {asin,title:text(p.title,'商品标题',500),unitsOrdered:numeric(p.unitsOrdered,'已订购商品数量',{integer:true,nullable:false})};
  }).sort((a,b)=>b.unitsOrdered-a.unitsOrdered||a.asin.localeCompare(b.asin));
  const report={storeKey,period:{start:dates[0],end:dates[1]},observedAt:new Date(payload.observedAt).toISOString(),source:'amazon-business-reports-dom',evidenceSha256:payload.evidenceSha256,
    sourceUrl:'https://sellercentral.amazon.com/business-reports/#/report?id=102:DetailSalesTrafficByChildItem',coverage:payload.coverage==='FULL_PAGE'?'FULL_PAGE':'PARTIAL_PAGE',products,
    note:text(payload.note,'选品说明',1000),updatedBy:actor};
  return mutateState(outDir,state=>{audit(state,'sales-baseline-saved',storeKey,actor,state.salesBaseline,report);state.salesBaseline=report;
    atomicJson(path.join(outDir,'intelligence','selection',`${report.observedAt.replace(/[^0-9TZ]/g,'')}-${randomUUID()}.json`),report);return report;});
}
export function reviewEvent(outDir,id,payload,actor) {
  return mutateState(outDir,state=>{
    const e=state.events.find(e=>e.id===id);if(!e)throw failure('机会记录不存在',404);
    if(!['unreviewed','useful','dismissed'].includes(payload.status))throw failure('复核状态无效');
    if((e.review?.version||0)!==payload.version)throw failure('复核已更新，请刷新',409);
    const review={version:(e.review?.version||0)+1,status:payload.status,note:text(payload.note,'复核备注',1000),by:actor,at:new Date().toISOString()};
    e.reviewHistory=[...(e.reviewHistory||[]),review].slice(-50);e.review=review;return e;
  });
}
