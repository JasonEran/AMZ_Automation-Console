import { createHash } from 'node:crypto';

/**
 * Build a filesystem-safe, collision-resistant artifact component.
 *
 * Sanitising alone is insufficient: `shop/a` and `shop?a` both become
 * `shop_a`, which can overwrite raw evidence or invalidate another store's
 * screenshot reference.  Keep a readable prefix and bind it to the exact raw
 * identity with a short digest.
 */
export function artifactPart(value) {
  const raw = String(value || 'unknown');
  const prefix = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[-.]+|[-.]+$/g, '').slice(0, 72) || 'unknown';
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${prefix}-${digest}`;
}
