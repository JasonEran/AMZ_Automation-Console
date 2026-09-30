import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { initialState, readState, statePath, mutateState, saveTarget, saveBusiness, saveSalesBaseline, requestRun, reviewEvent } from '../src/intelligence/store.js';
import { acceptance, recordSnapshot } from '../src/intelligence/rules.js';
import { parseProductText, parseSalesBadge, normalizeProduct, collectProduct } from '../src/intelligence/collector.js';
import { overview, history, ownHealth, comparisonGroups } from '../src/intelligence/views.js';
import { nextTarget, protectedWindow, runIntelligenceWorker } from '../src/intelligence/worker.js';
import { acquireRunLock, releaseRunLock } from '../src/checks/run.js';
import { classifyUrlSafety } from '../src/lib/page-safety.js';
import { retentionClass } from '../src/tools/retention.js';
import { INTELLIGENCE_PRODUCT_EXTRACTOR } from '../src/extractors/intelligence-product.js';
const stores=[{key:'US-A',id:'fixture',name:'Fixture',market:'US'}];
const now=Date.parse('2026-09-11T05:00:00Z');
function root(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'amzguard-intel-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
function target(out,p={}){return saveTarget(out,{asin:'B012345678',storeKey:'US-A',role:'competitor',productLine:'Ink',model:'M',capacity:'XL',color:'black',packCount:2,enabled:true,...p},stores,'tester');}
function snapshot(cents=2000,offset=0,extra={}){return {observedAt:new Date(now+offset).toISOString(),status:'COMPLETE',contextKey:'context-a',priceCents:cents,availability:'AVAILABLE',trusted:{price:true,availability:true},issues:[],evidence:{price:{dom:`$${cents/100}`,text:`$${cents/100}`}},...extra};}
const dom={asin:'B012345678',selectedAsin:'B012345678',title:'Sample ink',priceText:'$17.99 $17 . 99 Price history',availabilityText:'In Stock',hasCart:true,oneTimePurchase:true,deliveryContext:'New York 10010',language:'en-US'};
const page='One-time purchase $17.99 $17 . 99 Price history FREE delivery In Stock Add to cart Buy Now Subscribe & Save $17.09 Add to List';

test('independent catalog validates identity, concurrent edits, private data and versions',t=>{
 const out=root(t),item=target(out);assert.equal(readState(out).targets.length,1);
 assert.equal(fs.statSync(statePath(out)).mode&0o777,0o600);
 assert.throws(()=>target(out),/已存在/);
 assert.throws(()=>target(out,{asin:'../bad'}),/ASIN/);
 assert.throws(()=>target(out,{storeKey:'unknown'}),/美国站/);
 assert.throws(()=>saveTarget(out,{...item,version:0},stores,'x',item.id),/已更新/);
 const changed=saveTarget(out,{...item,label:'New'},stores,'x',item.id);assert.equal(changed.version,2);
 const disabled=saveTarget(out,{...changed,enabled:false},stores,'x',item.id);
 const replacement=target(out,{role:'own'});assert.notEqual(replacement.id,disabled.id);
 assert.throws(()=>saveTarget(out,{...disabled,enabled:true},stores,'x',disabled.id),/已存在/);
 fs.writeFileSync(statePath(out),'{broken');assert.throws(()=>readState(out),/未重置历史/);
});
test('one-time price excludes subscription and ambiguous or missing context remains unknown',()=>{
 assert.equal(parseProductText(page).priceCents,1799);
 const n=normalizeProduct({target:{asin:dom.asin,storeKey:'US-A'},dom,pageText:page});assert.equal(n.priceCents,1799);assert.equal(n.availability,'AVAILABLE');
 for(const patch of [{priceText:'$15.00'},{deliveryContext:''},{conditionalPrice:true},{selectedAsin:'B099999999'}]){
  const r=normalizeProduct({target:{asin:dom.asin,storeKey:'US-A'},dom:{...dom,...patch},pageText:page});assert.equal(r.trusted.price,false);
 }
 assert.equal(normalizeProduct({target:{asin:dom.asin,storeKey:'US-A'},dom,pageText:'Recommendation $17.99 Add to cart'}).trusted.price,false);
 assert.equal(normalizeProduct({target:{asin:dom.asin,storeKey:'US-A'},dom:{...dom,hasCart:false,availabilityText:'Currently unavailable'},pageText:'Currently unavailable'}).availability,'UNAVAILABLE');
 assert.equal(normalizeProduct({target:{asin:dom.asin,storeKey:'US-A'},dom:{...dom,hasCart:true,availabilityText:'Currently unavailable'},pageText:page}).availability,'UNKNOWN');
});
test('extractor is ASCII ES5 and reads calibrated visible roots without modifying the page',()=>{
 assert.doesNotMatch(INTELLIGENCE_PRODUCT_EXTRACTOR,/[^\x00-\x7f]|\b(?:let|const)\b|=>|`|\$\{/);
 const nodes={productTitle:{innerText:'Ink'},corePrice_feature_div:{innerText:'$17.99'},availability:{innerText:'In Stock'},desktop_buybox:{innerText:'One-time purchase $17.99'},'glow-ingress-line2':{innerText:'New York 10010'},'add-to-cart-button':{},ASIN:{value:dom.asin}};
 for(const n of Object.values(nodes))n.getClientRects=()=>[{}];
 const result=vm.runInNewContext(`(function(){${INTELLIGENCE_PRODUCT_EXTRACTOR}})()`,{document:{getElementById:id=>nodes[id],documentElement:{lang:'en-US'}},window:{getComputedStyle:()=>({})},location:{pathname:'/dp/'+dom.asin}});
 assert.equal(result.asin,dom.asin);assert.equal(result.priceText,'$17.99');assert.equal(result.hasCart,true);
 nodes.corePrice_feature_div.getClientRects=()=>[];
 assert.equal(vm.runInNewContext(`(function(){${INTELLIGENCE_PRODUCT_EXTRACTOR}})()`,{document:{getElementById:id=>nodes[id],documentElement:{lang:'en-US'}},window:{getComputedStyle:()=>({})},location:{pathname:'/dp/'+dom.asin}}).priceText,'');
});
test('changes require two distinct observations, deduplicate and preserve previous evidence',t=>{
 const out=root(t),item=target(out);recordSnapshot(out,item,snapshot());
 recordSnapshot(out,item,snapshot(2300,60000));assert.equal(readState(out).events.length,0);
 recordSnapshot(out,item,snapshot(2300,90000));assert.equal(readState(out).events.length,0);
 recordSnapshot(out,item,snapshot(2300,120000));assert.equal(readState(out).events.length,1);
 const event=readState(out).events[0];assert.equal(event.before.priceCents,2000);assert.equal(event.after.priceCents,2300);
 recordSnapshot(out,item,snapshot(2300,180000));assert.equal(readState(out).events.length,1);
 reviewEvent(out,event.id,{version:0,status:'useful',note:'verified'},'op');
 assert.throws(()=>reviewEvent(out,event.id,{version:0,status:'dismissed'},'op'),/已更新/);
 recordSnapshot(out,item,snapshot(2000,240000));recordSnapshot(out,item,snapshot(2000,300000));
 assert.equal(readState(out).events[0].lifecycle,'SUPERSEDED');assert.equal(readState(out).events[0].review.status,'useful');
 assert.equal(history(out,item.id).total,7);
});
test('failed, conflicting, context-changed and outdated samples never manufacture an opportunity',t=>{
 const out=root(t),item=target(out);recordSnapshot(out,item,snapshot());recordSnapshot(out,item,snapshot(2300,60000));
 recordSnapshot(out,item,snapshot(null,120000,{status:'ERROR',trusted:{price:false,availability:false}}));
 assert.equal(readState(out).baselines[item.id].price.priceCents,2000);
 recordSnapshot(out,item,snapshot(2300,180000));assert.equal(readState(out).events.length,0);
 recordSnapshot(out,item,snapshot(2300,240000,{contextKey:'other'}));assert.equal(readState(out).events.length,0);
 assert.equal(recordSnapshot(out,item,snapshot(5000,200000)).ignored,true);
 const newer=saveTarget(out,{...item,label:'revised'},stores,'op',item.id);
 assert.equal(recordSnapshot(out,item,snapshot(2300,300000)).ignored,true);
 assert.equal(readState(out).baselines[newer.id],undefined);
});
test('confirmed purchasability changes survive a missing quote but become non-actionable on missing current evidence',t=>{
 const out=root(t),item=target(out);recordSnapshot(out,item,snapshot());
 const unavailable=offset=>snapshot(null,offset,{status:'PARTIAL_EVIDENCE',availability:'UNAVAILABLE',trusted:{price:false,availability:true}});
 recordSnapshot(out,item,unavailable(60000));assert.equal(readState(out).events.length,0);
 recordSnapshot(out,item,unavailable(120000));
 assert.equal(readState(out).events.length,1);assert.equal(readState(out).events[0].type,'UNAVAILABLE');
 assert.equal(overview(out,stores,now+120000).events[0].actionable,true);
 recordSnapshot(out,item,snapshot(null,180000,{status:'ERROR',availability:'UNKNOWN',trusted:{price:false,availability:false}}));
 assert.equal(overview(out,stores,now+180000).events[0].actionable,false);
 recordSnapshot(out,item,snapshot(2000,240000));recordSnapshot(out,item,snapshot(2000,300000));
 assert.equal(readState(out).events[0].lifecycle,'SUPERSEDED');assert.equal(readState(out).events[1].type,'AVAILABLE');
});
test('stock, fees, matching and independent reports are all required for READY',t=>{
 const out=root(t),own=target(out,{role:'own'}),comp=target(out,{asin:'B076543210',ownTargetId:own.id,matchConfirmed:true});
 const base={version:0,asOf:new Date(now).toISOString(),validHours:24,inventory:40,minimumInventory:10,sellingPrice:20,unitCost:5,unitFees:4,minimumProfit:5,basis:'purchase + fulfillment + commission'};
 saveBusiness(out,own.id,base,'op',now);
 const health={[own.id]:{asin:{status:'PASS'},voc:{status:'PASS'}}};
 assert.equal(acceptance(comp,readState(out),health,now).status,'READY');
 assert.equal(acceptance(comp,readState(out),{},now).status,'PENDING');
 assert.equal(acceptance(comp,readState(out),health,now+25*3600000).status,'PENDING');
 assert.equal(acceptance({...comp,packCount:3},readState(out),health,now).status,'PENDING');
 saveBusiness(out,own.id,{...base,version:1,unitFees:null},'op',now);assert.equal(acceptance(comp,readState(out),health,now).status,'PENDING');
 saveBusiness(out,own.id,{...base,version:2,inventory:0},'op',now);assert.equal(acceptance(comp,readState(out),health,now).status,'UNMET');
 assert.throws(()=>saveBusiness(out,own.id,{...base,version:3,inventory:-1},'op',now),/库存/);
});
test('reads ASIN and VOC evidence only from local reports with complete per-ASIN status',t=>{
 const out=root(t),own=target(out,{role:'own'});
 for(const check of ['asin-health','voc'])fs.mkdirSync(path.join(out,check),{recursive:true});
 fs.writeFileSync(path.join(out,'asin-health','latest.json'),JSON.stringify({check:'asin-health',finishedAt:new Date(now).toISOString(),results:[{storeKey:'US-A',asin:own.asin,market:'US',ok:true,verdictSource:'dom+text',metrics:{collectionStatus:'COMPLETE',listingActive:true,hasCart:true}}]}));
 fs.writeFileSync(path.join(out,'voc','latest.json'),JSON.stringify({check:'voc',finishedAt:new Date(now).toISOString(),results:[{storeKey:'US-A',items:[{asin:own.asin,cxHealth:'Good',detailComplete:true,detailStatus:'COMPLETE'}]}]}));
 assert.equal(ownHealth(out,[own],now)[own.id].asin.status,'PASS');assert.equal(ownHealth(out,[own],now)[own.id].voc.status,'PASS');
 assert.equal(ownHealth(out,[own],now+40*3600000)[own.id].voc.status,'UNKNOWN');
 fs.copyFileSync(path.join(out,'voc','latest.json'),path.join(out,'voc','older.json'));
 fs.writeFileSync(path.join(out,'voc','latest.json'),JSON.stringify({check:'voc',finishedAt:new Date(now+60000).toISOString(),results:[{storeKey:'US-A',items:[]}]}));
 assert.equal(ownHealth(out,[own],now+60000)[own.id].voc.status,'UNKNOWN','a newer incomplete VOC report must not revive old PASS evidence');
 fs.copyFileSync(path.join(out,'asin-health','latest.json'),path.join(out,'asin-health','older.json'));
 fs.writeFileSync(path.join(out,'asin-health','latest.json'),JSON.stringify({check:'asin-health',selection:{targeted:false},finishedAt:new Date(now+60000).toISOString(),results:[{storeKey:'US-A',ok:false,verdictSource:'unknown',metrics:{collectionStatus:'ERROR'}}]}));
 assert.equal(ownHealth(out,[own],now+60000)[own.id].asin.status,'UNKNOWN','a newer failed full report must not revive old PASS evidence');
});
test('worker honors shared lease, schedule guard, and never invokes CRM or external notification',async t=>{
 const out=root(t),item=target(out);requestRun(out,'op');
 assert.equal(protectedWindow(Date.parse('2026-09-11T07:15:00Z')),true);
 assert.equal(protectedWindow(Date.parse('2026-09-11T05:00:00Z')),false);
 const config={outDir:out,crm:{enabled:true,endpoint:'https://invalid.example'},ziniao:{}},logger={info(){},warn(){}};
 const lease=acquireRunLock({outDir:out,label:'existing'});
 const calls=[];const zn={storeOpen:async()=>{calls.push('open');return {storeId:'fixture'};},storeClose:async()=>calls.push('close')};
 assert.equal((await runIntelligenceWorker({config,stores,logger,zn,now})).processed,false);assert.deepEqual(calls,[]);releaseRunLock(lease);
 const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw new Error('No network integrations permitted');};t.after(()=>{globalThis.fetch=oldFetch;});
 const r=await runIntelligenceWorker({config,stores,logger,zn,now,collect:async()=>snapshot()});
 assert.equal(r.processed,true);assert.deepEqual(calls,['open','close']);assert.equal(readState(out).request,null);
 assert.equal(fs.existsSync(path.join(out,'channels')),false);assert.equal(fs.existsSync(path.join(out,'runtime','run.lock')),false);
 assert.equal(nextTarget(readState(out),now),null);assert.equal(readState(out).latest[item.id].priceCents,2000);
});
test('collector discards all content when identity or live safety changes',async()=>{
 const target={asin:dom.asin,storeKey:'US-A'};let i=0;
 const zn={visit:async()=>{},execExtract:async()=>({result:dom}),content:async()=>({text:page})};
 const safety=async()=>classifyUrlSafety(++i===1?'https://www.amazon.com/dp/'+dom.asin:'https://www.amazon.com/ap/signin');
 const r=await collectProduct({zn,storeId:'x',target,config:{ziniao:{}},safety,wait:async()=>{}});
 assert.equal(r.status,'ERROR');assert.equal(r.priceCents,null);assert.deepEqual(r.evidence,{suppressed:true});
});
test('a non-auth page move is reread once, and a second move or sign-in is not',async()=>{
 const target={asin:dom.asin,storeKey:'US-A'};
 const product='https://www.amazon.com/dp/'+dom.asin;
 let phase=0,extracts=0;
 const zn={visit:async()=>{},execExtract:async()=>{extracts++;return {result:dom};},content:async()=>({text:page})};
 const safety=async()=>{
  phase++;
  if(phase===1)return {safe:false,code:'PAGE_CHANGED_DURING_LIVE_SAFETY_PROBE',authSensitive:false,blocked:false};
  return classifyUrlSafety(product);
 };
 const recovered=await collectProduct({zn,storeId:'x',target,config:{ziniao:{}},safety,wait:async()=>{}});
 assert.equal(recovered.status,'COMPLETE');assert.equal(recovered.priceCents,1799);assert.equal(extracts,1);assert.equal(phase,3);
 let signins=0;
 const blocked=await collectProduct({zn,storeId:'x',target,config:{ziniao:{}},safety:async()=>{signins++;return classifyUrlSafety('https://www.amazon.com/ap/signin');},wait:async()=>{}});
 assert.equal(blocked.status,'ERROR');assert.equal(blocked.evidence.suppressed,true);assert.equal(signins,1);
 let moves=0;
 const again=await collectProduct({zn,storeId:'x',target,config:{ziniao:{}},safety:async()=>{moves++;return {safe:false,code:'PAGE_CHANGED_DURING_LIVE_SAFETY_PROBE',authSensitive:false,blocked:false};},wait:async()=>{}});
 assert.equal(again.status,'ERROR');assert.equal(again.evidence.suppressed,true);assert.equal(moves,2);assert.equal(extracts,1);
});
test('intelligence state survives retention while time-series evidence has a retention category',()=>{
 assert.equal(retentionClass('state/intelligence/state.json'),'keep');
 assert.equal(retentionClass('intelligence/snapshots/target/file.json'),'report');
});
test('purchase badges require selected-page DOM and text agreement; missing is never zero',()=>{
 assert.equal(parseSalesBadge('1.5K+ bought in past month').bucketValue,1500);
 assert.equal(parseSalesBadge('300+ bought in past week'),null);
 assert.equal(parseSalesBadge('Customer says 300+ bought in past month'),null);
 const target={asin:dom.asin,storeKey:'US-A'}, badge='300+ bought in past month';
 assert.equal(normalizeProduct({target,dom:{...dom,salesBadge:badge},pageText:page+'\n'+badge}).salesTrend.bucketValue,300);
 for(const [d,p] of [[dom,page+'\n'+badge],[{...dom,salesBadge:badge},page+'\n500+ bought in past month'],[{...dom,salesBadge:badge,selectedAsin:'B099999999'},page+'\n'+badge]]){
  assert.equal(normalizeProduct({target,dom:d,pageText:p}).salesTrend,null);
 }
});
test('standard buy-box price is corroborated without requiring a subscription selector',()=>{
 const text='Join Prime\n$11.37\n$11\n.\n37\n$2.27 per count\n($2.27 / count)\nPrice history\nFREE delivery Wednesday\nOr Prime members get FREE delivery Tomorrow\nIn Stock\nQuantity:1\nAdd to cart\nBuy Now\nShips from\nAmazon\nSold by\nFixture seller\nReturns\nAdd to Auto Buy\nAdd to List';
 const d={...dom,priceText:'$11.37 $11 . 37 $2.27 per count',oneTimePurchase:false,plainPurchase:true};
 const target={asin:dom.asin,storeKey:'US-A'};
 assert.equal(normalizeProduct({target,dom:d,pageText:text}).priceCents,1137);
 for(const pageText of [text+'\n'+text,text.replace('FREE delivery Wednesday','Prime exclusive price'),text.replace('$11.37','$12.37')])assert.equal(normalizeProduct({target,dom:d,pageText}).priceCents,null);
 assert.equal(normalizeProduct({target,dom:{...d,conditionalPrice:true},pageText:text}).priceCents,null);
});
test('fixed-period own sales stay separate from competitor badges and other stores',t=>{
 const out=root(t),own=target(out,{role:'own'}),comp=target(out,{asin:'B076543210',ownTargetId:own.id,matchConfirmed:true});
 const payload={storeKey:'US-A',period:{start:'2026-08-10',end:'2026-09-10'},observedAt:new Date(now).toISOString(),evidenceSha256:'a'.repeat(64),coverage:'FULL_PAGE',products:[{asin:own.asin,title:'Own',unitsOrdered:80}]};
 saveSalesBaseline(out,payload,stores,'tester');
 recordSnapshot(out,own,snapshot());recordSnapshot(out,comp,snapshot(1900,0,{salesTrend:{bucketValue:1000,badgeText:'1K+ bought in past month'}}));
 const view=overview(out,stores,now);assert.equal(view.comparisons[0].baseline.unitsOrdered,80);assert.equal(view.comparisons[0].competitors[0].specsMatch,true);
 assert.equal(comparisonGroups(view.targets,{...view.salesBaseline,storeKey:'US-B'})[0].baseline,null);
 assert.equal(comparisonGroups(view.targets.map(t=>t.role==='competitor'?{...t,packCount:3}:t),view.salesBaseline)[0].competitors[0].specsMatch,false);
 assert.throws(()=>saveSalesBaseline(out,{...payload,products:[...payload.products,...payload.products]},stores,'tester'),/重复/);
 assert.throws(()=>saveSalesBaseline(out,{...payload,products:[{asin:own.asin,unitsOrdered:null}]},stores,'tester'),/数量/);
 assert.throws(()=>saveSalesBaseline(out,{...payload,period:{start:'2026-02-30',end:'2026-09-10'}},stores,'tester'),/区间/);
 const staleComp={...view.targets.find(t=>t.role==='competitor'),id:'stale',stale:true,latest:{salesTrend:{bucketValue:999999}}};
 assert.equal(comparisonGroups([...view.targets,staleComp],view.salesBaseline)[0].competitors.at(-1).id,'stale');
});
