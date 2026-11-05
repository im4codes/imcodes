import { expect, test } from '@playwright/test';
import { TASK_PAIR_TIMELINE_EVENT } from '../../shared/task-pair.js';

const brief = '# Actual explanation\n\n' + Array.from({ length: 5 }, (_, i) => `- [${i === 0 ? 'x' : ' '}][ ] Actual item ${i}`).join('\n');
const ruling = { id: 'ruling', project: 'fixture', taskId: 'compact', round: 1, kind: 'decision', conclusion: 'Approved', summary: 'Use isolated data', author: 'fixture-brain', at: 1700000000000 };
const payload = { taskId: 'compact', title: 'Synthetic compact task', status: 'working', toStatus: 'working', verb: 'WORKING', round: 1, flags: [], blocking: [], decisionRevision: 'fixture', latestDecision: ruling, brief,
  executor: 'deck_sub_compact_executor', auditor: 'deck_sub_compact_auditor', executorLabel: 'Same display', auditorLabel: 'Same display', executorModel: 'Model E', auditorModel: 'Model A' };

for (const surface of ['status', 'console']) for (const width of [320, 390, 1280]) {
  test(`compact decision, checklist and icon copy on ${surface} at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route('**/api/**', route => route.fulfill({ json: { value: true, pins: [] } }));
    await page.addInitScript(() => {
      localStorage.setItem('imcodes_lang', 'zh-CN');
      (window as any).__copies = []; (window as any).__decisionReads = 0;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copies.push(text); } } });
      window.addEventListener('fixture:decision-request', () => (window as any).__decisionReads++);
    });
    await page.goto(`/src/fixtures/chat-timeline/index.html?size=smoke&rows=1&pairControls=1&console=${surface === 'console' ? 1 : 0}`);
    await page.waitForFunction(() => (window as any).__chatTimelineHarness?.ready);
    // page.evaluate cannot close over imports: pass a plain event payload through its argument.
    await page.evaluate(type => { (window as any).__pairEventType = type; }, TASK_PAIR_TIMELINE_EVENT);
    const set = async (next: Record<string, unknown>) => {
      await page.evaluate(payload => (window as any).__chatTimelineHarness.setEvents([{ eventId: 'compact', sessionId: 'fixture-window-0', type: (window as any).__pairEventType, ts: 1700000000000, seq: 1, epoch: 0, source: 'daemon', confidence: 'high', payload }]), next);
      await page.waitForTimeout(80);
    };
    await set(payload);
    if (surface === 'status' && await page.locator('.task-pair-status-panel').evaluate(e => e.classList.contains('is-collapsed'))) await page.locator('.task-pair-status-compact').click();
    const host = page.locator(surface === 'status' ? '.task-pair-status-row' : '.supervision-task-console-task');
    const dimensions = await host.evaluate(e => { const r = e.getBoundingClientRect(); const copy = e.querySelector('.task-pair-brief-copy')!.getBoundingClientRect(); return { height: r.height, scrollWidth: e.scrollWidth, clientWidth: e.clientWidth, copyWidth: copy.width, copyHeight: copy.height }; });
    await info.attach(`compact-dimensions-${surface}-${width}`, { body: JSON.stringify(dimensions), contentType: 'application/json' });
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
    await expect(host).not.toContainText('卡点尚未说明');
    await expect(host.locator('.task-pair-decision-copy')).toContainText('Approved — Use isolated data');
    const toggle = host.locator('.task-pair-brief-checklist-toggle');
    await expect(toggle).toHaveText('1/5 : 0/5');
    expect(await toggle.getAttribute('aria-label')).toContain('1/5');
    expect(await toggle.getAttribute('title')).toContain('0/5');
    const copy = host.locator('.task-pair-brief-copy');
    await expect(copy).toHaveText(''); await expect(copy).toHaveAttribute('aria-label', '复制任务内容');
    expect(dimensions.copyWidth).toBeGreaterThanOrEqual(24);
    expect(dimensions.copyHeight).toBeGreaterThanOrEqual(12);
    await copy.focus(); await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__copies)).toEqual([brief]);
    await expect(copy).toHaveAttribute('aria-label', '已复制'); await expect(copy).toHaveText('');
    await page.screenshot({ path: info.outputPath(`${surface}-${width}-compact.png`) });
    await toggle.focus(); await page.keyboard.press('Enter');
    await expect(host.locator('.task-pair-brief-checklist-row')).toHaveCount(5);
    await host.locator('.task-pair-brief-toggle').click();
    await expect(host.locator('.chat-rich-text')).toContainText('Actual explanation');
    await expect(host.locator('.task-pair-brief-checklist')).toHaveCount(1);
    const longBrief = '# Actual explanation\n' + Array.from({ length: 101 }, (_, i) => `- [x][x] Long item ${i} 中文`).join('\n');
    await set({ ...payload, brief: longBrief });
    await expect(toggle).toHaveText('101/101 : 101/101');
    const panel = host.locator('.task-pair-brief-checklist-panel');
    const scroll = await panel.evaluate(e => ({ client: e.clientHeight, scroll: e.scrollHeight }));
    expect(scroll.scroll).toBeGreaterThan(scroll.client);
    await panel.hover(); await page.mouse.wheel(0, 300);
    await expect.poll(() => panel.evaluate(e => e.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({ path: info.outputPath(`${surface}-${width}-checklist-scroll.png`) });
    await toggle.click(); await expect(panel).toHaveCount(0);
    const emptyRuling = { ...ruling, conclusion: ' ', summary: '\n ' };
    await set({ ...payload, latestDecision: emptyRuling, brief: undefined, briefRevision: undefined });
    await expect(host.locator('.task-pair-decision-copy')).toHaveCount(0);
    await expect(host.locator('.task-pair-decision-time')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`${surface}-${width}-metadata-only.png`) });
    for (let i = 0; i < 5; i++) await set({ ...payload, latestDecision: emptyRuling, brief: undefined, summary: `stream ${i}` });
    expect(await page.evaluate(() => (window as any).__decisionReads)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}

test('compact controls keep touch, long-locale names and 200% layout usable', async ({ browser, baseURL }, info) => {
  const context = await browser.newContext({ baseURL, hasTouch: true, isMobile: true, viewport: { width: 320, height: 844 } });
  const page = await context.newPage();
  try {
    await page.route('**/api/**', route => route.fulfill({ json: { value: true, pins: [] } }));
    await page.addInitScript(() => {
      localStorage.setItem('imcodes_lang', 'ru'); (window as any).__copies = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copies.push(text); } } });
    });
    await page.goto('/src/fixtures/chat-timeline/index.html?size=smoke&rows=1&pairControls=1');
    await page.waitForFunction(() => (window as any).__chatTimelineHarness?.ready);
    await page.evaluate(({ payload, type }) => (window as any).__chatTimelineHarness.setEvents([{ eventId: 'compact', sessionId: 'fixture-window-0', type, ts: 1700000000000, seq: 1, epoch: 0, source: 'daemon', confidence: 'high', payload }]), { payload, type: TASK_PAIR_TIMELINE_EVENT });
    await page.locator('.task-pair-status-compact').tap();
    const host = page.locator('.task-pair-status-row');
    await expect(host.locator('.task-pair-brief-checklist-toggle')).toHaveText('1/5 : 0/5');
    expect(await host.locator('.task-pair-brief-copy').getAttribute('aria-label')).not.toMatch(/taskPair\./);
    await host.locator('.task-pair-brief-copy').tap();
    await expect.poll(() => page.evaluate(() => (window as any).__copies)).toEqual([brief]);
    await host.locator('.task-pair-brief-checklist-toggle').tap();
    await expect(host.locator('.task-pair-brief-checklist-row')).toHaveCount(5);
    await page.setViewportSize({ width: 640, height: 844 });
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('#fixture-root')!.style.zoom = '2';
      document.querySelector<HTMLElement>('#chat-timeline-fixture-harness')!.style.width = '50vw';
      document.querySelector<HTMLElement>('.chat-timeline-fixture-window')!.style.width = '50vw';
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    const g = await host.evaluate(e => ({ scroll: e.scrollWidth, client: e.clientWidth }));
    expect(g.scroll).toBeLessThanOrEqual(g.client + 1);
    await page.screenshot({ path: info.outputPath('ru-touch-200pct.png') });
  } finally { await context.close(); }
});
