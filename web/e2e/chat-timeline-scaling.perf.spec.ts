import { expect, test, type Page } from '@playwright/test';

// Keep the perf samples isolated. Running the two long-session probes in
// parallel on a shared CI runner makes the 8,000-row sample measure worker
// contention instead of renderer growth, which turns the flatness guard flaky.
test.describe.configure({ mode: 'serial' });

/**
 * Does the chat get slower as the conversation gets longer?
 *
 * This is a different question from "is virtual faster than legacy", and it is
 * the one that decides whether a long working session stays usable. A first
 * load happens once; updates happen continuously — a streamed reply is dozens
 * of updates a second, and a busy session appends messages all day. If the cost
 * of one update grows with how much has already been said, the chat degrades
 * the longer it is used, and no ratio against another renderer hides that.
 *
 * So this measures the renderer against ITSELF at increasing session lengths.
 * The pass condition is mostly a shape rather than a budget: per-update work
 * must not scale with how much has already been said.
 */

const FIXTURE = '/src/fixtures/chat-timeline/index.html';

/** Session lengths to compare, in generated presentation rows. */
const SIZES = [500, 2_000, 8_000] as const;

/** Updates per sample. Enough to see past one unlucky frame. */
const UPDATES = 40;

/**
 * Discarded updates before each sample.
 *
 * The first size measured pays for cold JIT of the whole app on that host. On a
 * GitHub runner that was enough to make the SHORTEST session look slower than a
 * 4x longer one (4.70ms at 500 rows against 2.40ms at 2,000) — the baseline was
 * measuring warm-up, not history. That inflated baseline is dangerous rather
 * than merely untidy; see `growthRatio`.
 */
const WARMUP_UPDATES = 25;

/**
 * How much growth across a 16x longer session still counts as flat.
 *
 * Chosen from both states rather than guessed. Measured in Chromium under 4x
 * CPU throttle, per-chunk work from a 500-row session to an 8,000-row one:
 *
 *   with the derivation window     0.60ms -> 1.60ms   (2.7x)
 *   deriving the whole session     0.80ms -> 5.10ms   (6.4x)
 *
 * So the limit has to sit between them. Four leaves the good state half again
 * as much headroom as it needs — these are sub-millisecond medians, where
 * timer granularity and scheduling move a ratio around — while still failing
 * loudly if per-update work goes back to scaling with history.
 */
const FLATNESS_LIMIT = 4;

/**
 * A ratio alone cannot see a uniform slowdown: make every size ten times worse
 * and the shape still looks flat. This is the absolute companion, generous
 * because it has to hold on whatever host CI gives us.
 */
const WORST_CASE_UPDATE_MS = 12;

/**
 * Growth across the measured sizes, divided by the FASTEST size rather than the
 * first one.
 *
 * Dividing by the first size lets a slow baseline hide a real regression: if
 * cold-start noise inflates the 500-row sample to 4.70ms, a regressed 8,000-row
 * sample at 15ms scores 3.2x and passes a limit of 4. Taking the minimum makes
 * the comparison conservative in the safe direction — noise on any one point
 * can only make this ratio larger, never smaller, so the guard errs toward
 * complaining rather than toward silence.
 */
function growthRatio(medians: number[]): { ratio: number; baseline: number; largest: number } {
  const baseline = Math.max(Math.min(...medians), 0.01);
  const largest = medians[medians.length - 1]!;
  return { ratio: largest / baseline, baseline, largest };
}

interface UpdateCost {
  medianMs: number;
  p95Ms: number;
  reflected: number;
}

async function waitForHarness(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const harness = (window as unknown as { __chatTimelineHarness?: { ready: boolean } }).__chatTimelineHarness;
    return harness?.ready === true;
  }, undefined, { timeout: 30_000 });
}

/**
 * Cost of one streaming chunk, measured as work on the main thread.
 *
 * Deliberately not update-to-paint: frame cadence on a shared host quantises
 * that to multiples of the refresh interval — 75ms of a 75ms sample can be
 * waiting — which swamps the signal this test looks for. Work is what grows
 * with history if anything does.
 */
async function measureStreamingUpdates(page: Page, updates: number): Promise<UpdateCost> {
  return page.evaluate(async (count) => {
    const harness = (window as unknown as {
      __chatTimelineHarness: {
        appendStreamingChunk(chunk?: string): { eventId: string; length: number };
      };
    }).__chatTimelineHarness;
    const scroller = document.querySelector('.chat-view') as HTMLElement;

    const samples: number[] = [];
    let reflected = 0;
    for (let i = 0; i < count; i++) {
      const marker = ` chunk-${i}`;
      const started = performance.now();
      harness.appendStreamingChunk(marker);
      // Preact commits in a microtask; three turns clears the enqueue plus any
      // cascade a layout effect schedules. The forced layout after it is what
      // makes this a real cost rather than "the render function returned".
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      scroller.getBoundingClientRect();
      samples.push(performance.now() - started);
      if ((scroller.textContent ?? '').includes(marker)) reflected += 1;
    }
    samples.sort((a, b) => a - b);
    return {
      medianMs: samples[Math.floor(samples.length / 2)] ?? 0,
      p95Ms: samples[Math.floor(samples.length * 0.95)] ?? 0,
      reflected: reflected / count,
    };
  }, updates);
}

/** Cost of a new message arriving, which changes the row count as well. */
async function measureAppendUpdates(page: Page, updates: number): Promise<UpdateCost> {
  return page.evaluate(async (count) => {
    const harness = (window as unknown as {
      __chatTimelineHarness: { appendEvent(options?: { type?: string; text?: string }): string };
    }).__chatTimelineHarness;
    const scroller = document.querySelector('.chat-view') as HTMLElement;

    const samples: number[] = [];
    let reflected = 0;
    for (let i = 0; i < count; i++) {
      const text = `arrival-${i} lorem ipsum dolor sit amet`;
      const started = performance.now();
      harness.appendEvent({ text });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      scroller.getBoundingClientRect();
      samples.push(performance.now() - started);
      if ((scroller.textContent ?? '').includes(`arrival-${i}`)) reflected += 1;
    }
    samples.sort((a, b) => a - b);
    return {
      medianMs: samples[Math.floor(samples.length / 2)] ?? 0,
      p95Ms: samples[Math.floor(samples.length * 0.95)] ?? 0,
      reflected: reflected / count,
    };
  }, updates);
}

test('streaming stays flat as the conversation grows', async ({ page }) => {
  const results: Array<{ size: number; cost: UpdateCost }> = [];
  for (const size of SIZES) {
    await page.goto(`${FIXTURE}?size=${size}`);
    await waitForHarness(page);
    await measureStreamingUpdates(page, WARMUP_UPDATES); // warm-up, discarded
    results.push({ size, cost: await measureStreamingUpdates(page, UPDATES) });
  }

  const table = results
    .map((r) => `${r.size}: median ${r.cost.medianMs.toFixed(2)}ms p95 ${r.cost.p95Ms.toFixed(2)}ms reflected ${(r.cost.reflected * 100).toFixed(0)}%`)
    .join('  |  ');
  // eslint-disable-next-line no-console
  console.log(`[streaming] ${table}`);

  // A sample that never reached the DOM describes nothing; fail loudly rather
  // than reporting a fast number for an update that did not happen.
  for (const result of results) {
    expect(result.cost.reflected, `${result.size} updates reached the DOM`).toBeGreaterThan(0.9);
  }
  const { ratio, baseline, largest } = growthRatio(results.map((r) => r.cost.medianMs));
  expect(
    ratio,
    `per-chunk work grew from ${baseline.toFixed(2)}ms at its fastest size to ${largest.toFixed(2)}ms at ${SIZES[SIZES.length - 1]} rows`,
  ).toBeLessThanOrEqual(FLATNESS_LIMIT);
  expect(largest, 'per-chunk work in the longest session').toBeLessThanOrEqual(WORST_CASE_UPDATE_MS);
});

test('message arrival stays flat as the conversation grows', async ({ page }) => {
  const results: Array<{ size: number; cost: UpdateCost }> = [];
  for (const size of SIZES) {
    await page.goto(`${FIXTURE}?size=${size}`);
    await waitForHarness(page);
    await measureAppendUpdates(page, WARMUP_UPDATES); // warm-up, discarded
    results.push({ size, cost: await measureAppendUpdates(page, UPDATES) });
  }

  const table = results
    .map((r) => `${r.size}: median ${r.cost.medianMs.toFixed(2)}ms p95 ${r.cost.p95Ms.toFixed(2)}ms reflected ${(r.cost.reflected * 100).toFixed(0)}%`)
    .join('  |  ');
  // eslint-disable-next-line no-console
  console.log(`[arrival] ${table}`);

  for (const result of results) {
    expect(result.cost.reflected, `${result.size} updates reached the DOM`).toBeGreaterThan(0.9);
  }
  const { ratio, baseline, largest } = growthRatio(results.map((r) => r.cost.medianMs));
  expect(
    ratio,
    `per-arrival work grew from ${baseline.toFixed(2)}ms at its fastest size to ${largest.toFixed(2)}ms at ${SIZES[SIZES.length - 1]} rows`,
  ).toBeLessThanOrEqual(FLATNESS_LIMIT);
  expect(largest, 'per-arrival work in the longest session').toBeLessThanOrEqual(WORST_CASE_UPDATE_MS);
});
