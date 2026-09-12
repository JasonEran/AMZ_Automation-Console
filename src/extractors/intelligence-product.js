// Read-only US retail fields. Calibrated through official Ziniao WebDriver on
// 2026-09-11 (corePrice_feature_div, desktop_buybox, availability, glow-ingress-line2).
// ASCII ES5 only; the source below is a Selenium executeScript BODY.
export const INTELLIGENCE_PRODUCT_EXTRACTOR = [
  'function norm(v){return String(v||"").replace(/\\s+/g," ").trim();}',
  'function visible(e){if(!e)return false;if(e.getClientRects&&e.getClientRects().length===0)return false;var s=window.getComputedStyle?window.getComputedStyle(e):null;return !s||(s.display!=="none"&&s.visibility!=="hidden"&&s.opacity!=="0");}',
  'function nodeText(id){var e=document.getElementById(id);return visible(e)?norm(e.innerText||e.textContent):"";}',
  'var title=nodeText("productTitle"), price=nodeText("corePrice_feature_div"), av=nodeText("availability"), box=nodeText("desktop_buybox");',
  'var cart=document.getElementById("add-to-cart-button"), buy=document.getElementById("buy-now-button");',
  'var m=/\\/(?:dp|gp\\/product)\\/([A-Z0-9]{10})/i.exec(location.pathname);',
  'var asinNode=document.getElementById("ASIN");',
  'return {extractor:"intelligence-product/v2",asin:m?m[1].toUpperCase():null,selectedAsin:asinNode?String(asinNode.value||"").toUpperCase():null,title:title.slice(0,300),brand:nodeText("bylineInfo").slice(0,160),salesBadge:nodeText("socialProofingAsinFaceout_feature_div").slice(0,180),priceText:price.slice(0,400),availabilityText:av.slice(0,200),hasCart:visible(cart)||visible(buy),oneTimePurchase:/one-time purchase/i.test(box),plainPurchase:/^\\$[0-9,.]+ \\$/.test(box)&&!/one-time purchase|subscribe|installment/i.test(box)&&!/prime exclusive|with prime/i.test(box.split(/Price history|FREE delivery/i)[0]),deliveryContext:nodeText("glow-ingress-line2").slice(0,120),language:String(document.documentElement.lang||""),conditionalPrice:/prime exclusive|with prime|subscribe|installment/i.test(price)};'
].join('\n');
