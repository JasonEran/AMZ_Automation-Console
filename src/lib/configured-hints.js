/**
 * Resolve a non-secret configuration readiness hint supplied to a least-
 * privilege process. An explicit false value must override the fallback;
 * malformed values fail closed instead of being treated as configured.
 */
export function configuredHint(name, fallback = false, env = process.env) {
  if (!Object.prototype.hasOwnProperty.call(env, name)) return Boolean(fallback);
  const value = String(env[name] ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(value)) return true;
  return false;
}
