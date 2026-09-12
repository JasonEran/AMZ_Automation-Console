import { createHash } from 'node:crypto';
import { INTELLIGENCE_PRODUCT_EXTRACTOR } from '../extractors/intelligence-product.js';
import { classifyAsinProductReadSafety, classifyPageSafety, rawPageIdentity } from '../lib/page-safety.js';
import { redactText, sanitizeForStorage } from '../lib/redact.js';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const dollars=s=>{const m=/\$\s*([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)\.([0-9]{2})(?!\d)/.exec(s);return m?Math.round(Number(m[1].replace(/,/g,''))*100)+Number(m[2]):null;};
// Amazon's display is a broad purchase trend, not exact units or store sales.
export function parseSalesBadge(value) {
  const text=String(value||'').replace(/\s+/g,' ').trim();
  const m=/^(\d+(?:,\d{3})*(?:\.\d+)?)([KM])?\+ bought in past month$/i.exec(text);
  if(!m)return null;
  const bucketValue=Number(m[1].replace(/,/g,''))*({K:1000,M:1000000}[m[2]?.toUpperCase()]||1);
  if(!Number.isSafeInteger(bucketValue)||bucketValue<=0)return null;
  return {badgeText:text,bucketValue,period:'past_month',source:'amazon-product-page',variationScope:'unverified'};
}
export function parseProductText(body,{plainPurchase=false}={}) {
  const text=String(body||'').replace(/\s+/g,' ').trim();
  const oneTime=plainPurchase?null:/One-time purchase\s*([^]*?)(?=Subscribe\s*&\s*Save|Add to List|$)/i.exec(text);
  // Calibrated standard buy box: standalone price, split duplicate price,
  // Price history, delivery, then the primary purchase and seller controls.
  const plain=plainPurchase?String(body||'').match(/(?:^|\n)(\$[\d,]+\.\d{2})\s*\n\$[\d,]+\s*\n\.\s*\n\d{2}\b[^]*?Price history\s*\nFREE delivery[^]*?Add to cart\s*\nBuy Now\s*\nShips from\s*\n[^]*?Sold by\s*\n[^]*?Add to List/g):null;
  const validPlain=plain?.length===1&&plain[0].length<1800?plain[0].trim():'';
  const offer=oneTime?oneTime[1].slice(0,1500):validPlain;
  const pricePrefix=offer.split(/FREE delivery|Price history|In Stock|Add to cart/i)[0];
  const priceCents=dollars(pricePrefix);
  const cart=/\b(?:Add to cart|Buy Now)\b/i.test(text);
  const unavailable=/Currently unavailable|out of stock|we don.t know when or if this item will be back/i.test(text);
  return {priceCents,oneTimePurchase:!!oneTime,plainPurchase:!!validPlain,priceText:pricePrefix.slice(0,180),hasCart:cart,pageUnavailable:unavailable,
    availabilityText:unavailable?'Currently unavailable / out of stock':cart?'Add to cart / Buy Now':'No explicit purchase status',
    conditionalPrice:/prime exclusive|with prime|subscribe|installment/i.test(pricePrefix)};
}
export function normalizeProduct({target,dom,pageText,observedAt=new Date().toISOString()}) {
  const txt=parseProductText(pageText,{plainPurchase:dom?.plainPurchase===true}),issues=[];
  const domCents=dollars(dom?.priceText||'');
  const identity=dom?.asin===target.asin&&(!dom.selectedAsin||dom.selectedAsin===target.asin);
  const contextReady=!!dom?.deliveryContext&&/^en(?:-|$)/i.test(dom.language||'');
  const titleReady=!!dom?.title;
  const badge=parseSalesBadge(dom?.salesBadge);
  const badgeCorroborated=badge&&String(pageText||'').split('\n').some(line=>line.replace(/\s+/g,' ').trim()===badge.badgeText);
  const salesTrend=identity&&titleReady&&contextReady&&badgeCorroborated?badge:null;
  const contextKey=createHash('sha256').update(JSON.stringify([target.storeKey,'US',dom?.deliveryContext||null,dom?.language||null,'one-time-usd'])).digest('hex');
  const purchaseConfirmed=(dom.oneTimePurchase&&txt.oneTimePurchase)||(dom.plainPurchase&&txt.plainPurchase);
  let priceTrusted=identity&&titleReady&&contextReady&&purchaseConfirmed&&!dom.conditionalPrice&&!txt.conditionalPrice&&domCents>0&&domCents===txt.priceCents;
  const domUnavailable=/Currently unavailable|out of stock|we don.t know when or if this item will be back/i.test(dom?.availabilityText||'');
  let availability='UNKNOWN';
  if(identity&&titleReady&&contextReady) {
    if(domUnavailable&&txt.pageUnavailable&&!dom.hasCart)availability='UNAVAILABLE';
    else if(dom.hasCart&&txt.hasCart&&!domUnavailable)availability='AVAILABLE';
  }
  if(!identity)issues.push('商品身份不一致');
  if(!contextReady)issues.push('配送环境或语言未确认');
  if(!priceTrusted)issues.push('一次性购买报价尚未取得一致双路证据');
  if(availability==='UNKNOWN')issues.push('可购买状态证据不足或冲突');
  // Visible one-time offer only; coupon/Prime/subscription entitlements are not evaluated.
  return {observedAt,status:priceTrusted&&availability!=='UNKNOWN'?'COMPLETE':'PARTIAL_EVIDENCE',title:dom?.title||null,
    brand:dom?.brand||null,salesTrend,contextKey,offerBasis:'一次性购买展示价（未计条件优惠）',currency:'USD',priceCents:priceTrusted?domCents:null,availability,
    trusted:{price:!!priceTrusted,availability:availability!=='UNKNOWN'},issues,
    evidence:{salesTrend:{dom:dom?.salesBadge||'',text:badgeCorroborated?badge.badgeText:'',selector:'#socialProofingAsinFaceout_feature_div',status:salesTrend?'VERIFIED_BADGE':'UNKNOWN'},price:{dom:dom?.priceText||'',text:txt.priceText,selector:'#corePrice_feature_div'},availability:{dom:dom?.availabilityText||'',text:txt.availabilityText,hasMainCart:!!dom?.hasCart},identity:{asin:dom?.asin,selectedAsin:dom?.selectedAsin,language:dom?.language},contextConfirmed:contextReady}};
}
export async function collectProduct({zn,storeId,target,config,safety=classifyAsinProductReadSafety,wait=pause}) {
  const url=`https://www.amazon.com/dp/${target.asin}`;
  try {
    await zn.visit(storeId,url,{timeoutMs:120000,waitUntil:config.ziniao?.waitUntil});
    await wait(Math.max(1500,Math.min(5000,config.asinHealth?.settleMs||config.ziniao?.settleMs||2500)));
    for(let attempt=0;attempt<2;attempt++) {
      const pre=await safety({zn,storeId,expectedAsin:target.asin});
      if(!pre.safe)throw new Error(pre.code||'PAGE_SAFETY_FAILED');
      const dom=(await zn.execExtract(storeId,INTELLIGENCE_PRODUCT_EXTRACTOR,{timeoutMs:45000})).result;
      const pageText=(await zn.content(storeId,{format:'text',timeoutMs:45000})).text||'';
      const post=await safety({zn,storeId,expectedAsin:target.asin});
      if(!post.safe||!rawPageIdentity(pre)||rawPageIdentity(pre)!==rawPageIdentity(post))throw new Error(post.code||'PAGE_IDENTITY_CHANGED');
      const contentSafety=classifyPageSafety({currentUrl:rawPageIdentity(post),dom:{landed:!!dom.title},pageText});
      if(!contentSafety.safe)throw new Error(contentSafety.code||'CONTENT_UNSAFE');
      if(dom.asin!==target.asin||(dom.selectedAsin&&dom.selectedAsin!==target.asin))throw new Error('ASIN_IDENTITY_MISMATCH');
      const result=normalizeProduct({target,dom,pageText});
      result.evidence.safety={pre:pre.code,post:post.code,identityStable:true};
      if(result.status==='COMPLETE'||attempt===1)return sanitizeForStorage(result,{rootDir:config.outDir});
      await wait(2000);
    }
  }catch(e){return {observedAt:new Date().toISOString(),status:'ERROR',title:null,priceCents:null,availability:'UNKNOWN',trusted:{price:false,availability:false},issues:[redactText(String(e.message)).slice(0,220)],evidence:{suppressed:true},contextKey:null};}
}
