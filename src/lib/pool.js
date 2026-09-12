import { sleep } from './time.js';

/**
 * Bounded worker pool.
 *
 * Used to run per-store checks with a configurable concurrency cap. Three
 * properties matter for this system:
 *
 *  - Results keep the input order regardless of completion order, so reports and
 *    CSV rows are deterministic and diffable across runs.
 *  - `peakActive` is reported back, so tests can assert the cap is actually
 *    honoured rather than assumed.
 *  - Store *starts* are separated by at least `staggerMs`, so several Ziniao
 *    browsers never launch in the same instant.
 *
 * Concurrency here is strictly *across* stores. Steps within one store stay
 * sequential — one Ziniao store is one browser profile and one Amazon session,
 * and overlapping requests inside a single session is exactly the pattern worth
 * avoiding.
 */
export async function mapWithConcurrency(items, worker, { limit = 1, staggerMs = 0, jitterMs = 0 } = {}) {
  const n = items.length;
  const results = new Array(n);
  const cap = Math.max(1, Math.min(limit || 1, n || 1));

  let next = 0;
  let active = 0;
  let peakActive = 0;

  // Monotonic gate holding the earliest instant the next store may start.
  // A shared counter would not work: concurrent lanes all read the same value
  // before any of them increments, so they would each wait the same amount in
  // parallel and not actually be staggered.
  let nextStartAt = 0;

  async function gate() {
    if (!staggerMs && !jitterMs) return;
    const now = Date.now();
    const startAt = Math.max(now, nextStartAt);
    const jitter = jitterMs ? Math.floor(Math.random() * jitterMs) : 0;
    // Reserve the slot synchronously — no await between read and write, so
    // lanes cannot race for the same start window.
    nextStartAt = startAt + staggerMs + jitter;
    const wait = startAt - now;
    // When items take longer than staggerMs the gate is already in the past, so
    // slow runs pay no cumulative penalty.
    if (wait > 0) await sleep(wait);
  }

  async function lane() {
    for (;;) {
      const i = next++;
      if (i >= n) return;

      await gate();

      active++;
      if (active > peakActive) peakActive = active;
      try {
        results[i] = await worker(items[i], i);
      } finally {
        active--;
      }
    }
  }

  await Promise.all(Array.from({ length: cap }, () => lane()));
  return { results, peakActive, limit: cap };
}
