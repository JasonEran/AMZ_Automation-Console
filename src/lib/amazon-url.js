const AMAZON_SUFFIXES = Object.freeze([
  'amazon.com', 'amazon.ca', 'amazon.com.mx', 'amazon.com.br',
  'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.it', 'amazon.es',
  'amazon.nl', 'amazon.se', 'amazon.pl', 'amazon.com.be', 'amazon.com.tr',
  'amazon.co.jp', 'amazon.in', 'amazon.com.au', 'amazon.sg',
  'amazon.ae', 'amazon.sa', 'amazon.eg',
]);

export function isApprovedAmazonHostname(value) {
  const hostname = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  return AMAZON_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/** Public retail surfaces only; excludes Seller Central, Ads and arbitrary subdomains. */
export function isApprovedAmazonRetailHostname(value) {
  const hostname = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  return AMAZON_SUFFIXES.some((suffix) => hostname === suffix || hostname === `www.${suffix}`);
}

export function approvedAmazonUrl(value, { base } = {}) {
  let parsed;
  try { parsed = base ? new URL(value, base) : new URL(value); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
  if (!isApprovedAmazonHostname(parsed.hostname)) return null;
  return parsed;
}

export function assertApprovedAmazonUrl(value, options = {}) {
  const parsed = approvedAmazonUrl(value, options);
  if (!parsed) throw new Error('拒绝访问非 Amazon HTTPS 目标');
  return parsed.toString();
}
