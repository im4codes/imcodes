import { expect, test, type Page } from '@playwright/test';
import type { TimelineEvent } from '../src/ws-client.js';
import { TASK_PAIR_TIMELINE_EVENT } from '../../shared/task-pair.js';
import { readFileSync } from 'node:fs';

// Optional exact-base stylesheet for a same-component causal control. No
// production component is mocked or replaced and the route never writes files.
test.beforeEach(async ({ page }) => {
  if (process.env.PAIR_LAYOUT_BASE_CSS) {
    const css = readFileSync(process.env.PAIR_LAYOUT_BASE_CSS, 'utf8');
    await page.route('**/styles-*.css', route => route.fulfill({ contentType: 'text/css', body: css }));
  }
});

const FIXTURE = '/src/fixtures/chat-timeline/index.html?size=smoke&rows=1&pairControls=1&pins=1';
const SUMMARY = 'Synthetic source review: 中文说明、English, URL https://example.test/' + 'abcdef0123456789'.repeat(4);
function event(id: string, payload: Record<string, unknown>, type: TimelineEvent['type'] = TASK_PAIR_TIMELINE_EVENT): TimelineEvent {
  return { eventId: id, sessionId: 'fixture-window-0', ts: 1700000000000, seq: 1, epoch: 0, source: 'daemon', confidence: 'high', type, payload };
}
function pair(payload: Record<string, unknown> = {}, id = 'pair'): TimelineEvent {
  return event(id, { taskId: id, title: 'Synthetic review and input controls', writer: 'deck_fixture_auditor', verb: 'PASS', toStatus: 'passed', executor: 'deck_fixture_executor', auditor: 'deck_fixture_auditor', executorLabel: 'Same label', auditorLabel: 'Same label', summary: SUMMARY, ...payload });
}
async function publish(page: Page, events: TimelineEvent[]) {
  await page.evaluate(events => (window as any).__chatTimelineHarness.setEvents(events), events);
  await page.waitForTimeout(80);
}
async function open(page: Page, width = 390, language = 'en', extra = '') {
  await page.setViewportSize({ width, height: 844 });
  await page.route('**/api/**', route => route.fulfill({ json: { value: true, pins: [{ id: 'pin', serverId: 'fixture-server', sessionName: 'fixture-window-0', eventId: 'user', eventTs: 1700000000000, eventType: 'user.message', text: 'Synthetic pinned message', createdAt: 1, updatedAt: 1 }] } }));
  await page.addInitScript(language => { localStorage.setItem('imcodes_lang', language); }, language);
  await page.goto(FIXTURE + extra);
  await page.waitForFunction(() => (window as any).__chatTimelineHarness?.ready);
}
async function geometry(page: Page) {
  return page.locator('.task-pair-event-card').last().evaluate(card => {
    const body = card.querySelector<HTMLElement>('.task-pair-card-body')!;
    const audit = card.querySelector<HTMLElement>('.task-pair-card-audit-details');
    const rect = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, height: r.height, width: r.width }; };
    const px = (value: string) => parseFloat(value) || 0;
    const auditStyle = audit && getComputedStyle(audit);
    const naturalAuditHeight = audit && auditStyle ? [...audit.children].reduce((sum, child) => {
      const style = getComputedStyle(child);
      return sum + child.getBoundingClientRect().height + px(style.marginTop) + px(style.marginBottom);
    }, px(auditStyle.paddingTop) + px(auditStyle.paddingBottom) + px(auditStyle.borderTopWidth) + px(auditStyle.borderBottomWidth) + Math.max(0, audit.children.length - 1) * px(auditStyle.rowGap)) : 0;
    return { card: rect(card), body: rect(body), audit: audit && rect(audit), scrollWidth: card.scrollWidth, clientWidth: card.clientWidth,
      auditBlankHeight: audit ? audit.getBoundingClientRect().height - naturalAuditHeight : 0,
      direction: getComputedStyle(body).flexDirection, wrap: getComputedStyle(body).flexWrap,
      children: [...body.children].map(e => ({ ...rect(e), name: e.className })),
      documentOverflow: document.documentElement.scrollWidth > innerWidth };
  });
}
async function expectContained(page: Page) {
  const g = await geometry(page);
  expect(g.scrollWidth, JSON.stringify(g)).toBeLessThanOrEqual(g.clientWidth + 1);
  expect(g.documentOverflow).toBe(false);
  for (const r of g.children) {
    expect(r.x, r.name).toBeGreaterThanOrEqual(g.body.x - 1);
    expect(r.right, r.name).toBeLessThanOrEqual(g.body.right + 1);
  }
  if (g.audit) {
    expect(g.auditBlankHeight).toBeLessThanOrEqual(1);
    expect(g.audit.x).toBeCloseTo(g.body.x, 0);
    // All body children must contribute to one natural-height column. No
    // spare 100%-basis column/height may be inserted beside the writer.
    expect(g.audit.y).toBeGreaterThan(g.children[0]!.bottom);
    expect(g.body.height).toBeLessThan(g.children.reduce((sum, c) => sum + c.height, 0) + g.children.length * 16);
  }
  return g;
}
async function snapshot(page: Page, counts = [111, 22, 3, 44]) {
  const statuses = ['working', 'in_audit', 'queued', 'awaiting_brain_decision'];
  await page.evaluate(({ statuses, counts }) => {
    const tasks = statuses.flatMap((status, s) => Array.from({ length: counts[s] }, (_, i) => ({ taskId: `state-${s}-${i}`, title: 'Synthetic queue item', pair: { status, round: 1, executor: 'fixture-window-0', updatedAt: 1700000000001 } })));
    window.dispatchEvent(new CustomEvent('supervision:task-pairs', { detail: { tasks } }));
  }, { statuses, counts });
  await expect(page.locator('.task-pair-status-panel')).toHaveClass(/is-collapsed/);
}
async function stripGeometry(page: Page) {
  return page.locator('.chat-titlebar').evaluate(titlebar => {
    const strip = titlebar.querySelector<HTMLElement>('.task-pair-status-panel')!;
    const toggle = strip.querySelector<HTMLElement>('.task-pair-status-toggle')!;
    const content = strip.querySelector<HTMLElement>('.task-pair-status-icons')!;
    const rect = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const actions = document.querySelector('.chat-top-actions')!;
    return { titlebar: rect(titlebar), strip: rect(strip), toggle: rect(toggle), content: rect(content), actions: rect(actions),
      padding: getComputedStyle(titlebar).paddingRight, maxWidth: getComputedStyle(strip).maxWidth,
      counts: [...strip.querySelectorAll<HTMLElement>('.task-pair-status-icon:not(.is-zero)')].map(e => ({ text: e.textContent, ...rect(e) })),
      neighbors: [...titlebar.querySelectorAll<HTMLElement>(':scope > :not(.task-pair-status-panel)')].map(rect),
      pseudo: getComputedStyle(toggle, '::before').inset };
  });
}

test('causal: PASS audit stays below writer with natural height in real ChatView', async ({ page }, info) => {
  await open(page);
  await publish(page, [pair()]);
  await page.locator('.task-pair-card-toggle').click();
  await page.waitForTimeout(100); // real lazy decision reply
  const g = await geometry(page);
  await info.attach('geometry', { body: JSON.stringify(g, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('pass-expanded.png') });
  await expectContained(page);
  expect(g.body.height).toBeLessThan(300);
});

test('causal: portal task strip keeps every nonzero number inside the titlebar', async ({ page }, info) => {
  await open(page);
  await publish(page, [pair()]);
  await snapshot(page);
  const g = await stripGeometry(page);
  await info.attach('strip-geometry', { body: JSON.stringify(g, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('strip.png') });
  for (const count of g.counts) {
    expect(count.x, count.text!).toBeGreaterThanOrEqual(g.content.x - 1);
    expect(count.right, count.text!).toBeLessThanOrEqual(g.content.right + 1);
  }
  expect(g.strip.right).toBeLessThan(g.actions.x);
  expect(g.titlebar.height).toBeLessThanOrEqual(33);
});

for (const width of [320, 390, 640, 641, 720, 721, 1280]) {
  test(`expanded geometry and repeat toggle at ${width}px`, async ({ page }) => {
    await open(page, width);
    const cases = [pair(), pair({ verb: 'REWORK', toStatus: 'rework', findings: [0, 1, 2].map(i => ({ severity: 'P0', summary: `Finding ${i} ${SUMMARY}`, evidence: 'line\n'.repeat(5), proposal: 'Safe synthetic repair' })) }), pair({ verb: 'REWORK', toStatus: 'rework', findings: [{ severity: 'P0', summary: SUMMARY }] }), pair({ verb: 'WORKING', toStatus: 'working', summary: undefined, noticeText: SUMMARY }), pair({ verb: 'BLOCKED', toStatus: 'working', blockedNote: SUMMARY }), pair({ verb: 'CANCEL', toStatus: 'cancelled', cancelReason: SUMMARY, cancelActor: 'owner', noticeText: (SUMMARY + '\n').repeat(25) })];
    for (const input of cases) {
      await publish(page, [input]);
      const toggle = page.locator('.task-pair-card-toggle');
      if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
      const collapsed = (await page.locator('.task-pair-event-card').boundingBox())!.height;
      // Exact-base measurements for this same title/payload: compact defaults
      // were96.8px at320, at most65px below640 and58px through720. Expansion fixes must not grow them.
      if (width <= 720) expect(collapsed).toBeLessThanOrEqual(width <= 320 ? 97 : width <= 640 ? 65 : 58);
      await toggle.click();
      // At desktop widths body is row-wrapped by design; only compact is column.
      if (width <= 720) await expectContained(page);
      else { const g = await geometry(page); expect(g.scrollWidth, JSON.stringify(g)).toBeLessThanOrEqual(g.clientWidth + 1); }
      await page.locator('.task-pair-card-payload summary').click();
      const pre = page.locator('.task-pair-card-payload pre');
      await pre.evaluate(e => { e.scrollTop = e.scrollHeight; });
      expect(await pre.evaluate(e => e.scrollTop + e.clientHeight >= e.scrollHeight - 1)).toBe(true);
      await toggle.click();
      expect((await page.locator('.task-pair-event-card').boundingBox())!.height).toBeCloseTo(collapsed, 0);
    }
  });
}

for (const language of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es', 'ru']) {
  test(`task strip numbers and neighboring clicks: ${language}`, async ({ page }) => {
    await open(page, 320, language, '&branch=synthetic-long-branch-name-for-layout');
    await publish(page, [pair()]);
    await snapshot(page, [111, 22, 3, 44]);
    const g = await stripGeometry(page);
    for (const c of g.counts) expect(c.right, `${c.text}: ${JSON.stringify(g)}`).toBeLessThanOrEqual(g.content.right + 1);
    expect(g.strip.right).toBeLessThan(g.actions.x);
    for (const n of g.neighbors) expect(n.right).toBeLessThanOrEqual(g.strip.x + 1);
    await page.evaluate(() => { (window as any).__syncs = 0; window.addEventListener('fixture:sync', () => (window as any).__syncs++); });
    await page.locator('.chat-sync-btn').click();
    expect(await page.evaluate(() => (window as any).__syncs)).toBe(1);
    await expect(page.locator('.task-pair-status-panel')).toHaveClass(/is-collapsed/);
    const preferencesBefore = await page.evaluate(() => JSON.stringify(localStorage));
    await page.locator('.chat-sdk-agents-toggle').click();
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toBe(preferencesBefore);
    await expect(page.locator('.task-pair-status-panel')).toHaveClass(/is-collapsed/);
    await page.locator('.message-pins-summary').click();
    await expect(page.locator('.message-pins-panel')).toBeVisible();
    await page.locator('.message-pins-summary').click();
    await page.locator('.chat-top-actions > .chat-panel-toggle').last().click();
    await expect(page.locator('.chat-file-panel')).toBeVisible();
    await page.locator('.chat-top-actions > .chat-panel-toggle').last().click();
    await page.locator('.task-pair-status-compact').click();
    await expect(page.locator('.task-pair-status-rows')).toBeVisible();
    await page.locator('.task-pair-status-toggle').click();
    await expect(page.locator('.task-pair-status-panel')).toHaveClass(/is-collapsed/);
    await page.getByRole('button', { name: 'Aa', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  });
}

test('retained virtual chat, lazy decisions, scrolling and canonical role clicks survive resize/zoom', async ({ page }, info) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' }));
  await open(page, 390, 'zh-CN', '&chrome=1');
  await page.evaluate(() => {
    document.documentElement.classList.add('native-ios-mac');
    (window as any).__requests = 0; (window as any).__navigated = [];
    window.addEventListener('fixture:decision-request', () => (window as any).__requests++);
    window.addEventListener('deck:navigate', (e: any) => (window as any).__navigated.push(e.detail.session));
    (window as any).__chatTimelineHarness.setDecisionRecords([{ id: 'decision', taskId: 'pair', project: 'fixture', round: 1, kind: 'request', conclusion: '', question: ('Synthetic decision line 中文\n').repeat(15), summary: 'Synthetic request', author: 'fixture-brain', at: 1700000000000 }]);
  });
  const preceding = Array.from({ length: 50 }, (_, i) => event(`history-${i}`, { text: `Synthetic history ${i}` }, 'user.message'));
  const target = pair({ verb: 'WORKING', toStatus: 'working', noticeText: ('Synthetic notice\n' + SUMMARY + '\n').repeat(30), executor: 'deck_fixture_executor_long_canonical_name', auditor: 'deck_fixture_auditor_long_canonical_name', executorModel: SUMMARY, auditorModel: SUMMARY });
  const linkedUser = event('linked-user', { text: 'Synthetic linked request' }, 'user.message');
  const memory = event('linked-memory', { relatedToEventId: 'linked-user', text: 'Synthetic context', content: 'Synthetic context' }, 'memory.context');
  await publish(page, [...preceding, linkedUser, memory, target]);
  await expect(page.locator('.chat-linked-event-group')).toBeVisible();
  expect(await page.locator('.chat-virtual-item').count()).toBeGreaterThan(0);
  await page.locator('.task-pair-card-toggle').click();
  await expect(page.locator('.task-pair-decision-copy')).toBeVisible();
  await expectContained(page);
  expect(await page.evaluate(() => (window as any).__requests)).toBe(1);
  const decision = page.locator('.task-pair-decision-copy .expandable-task-objective-text');
  const dg = await decision.evaluate(e => ({ client: e.clientHeight, scroll: e.scrollHeight, line: parseFloat(getComputedStyle(e).lineHeight) }));
  expect(dg.scroll).toBeGreaterThan(dg.client); expect(dg.client).toBeLessThanOrEqual(dg.line * 5 + 1);
  await decision.evaluate(e => { e.scrollTop = e.scrollHeight; });
  expect(await decision.evaluate(e => e.scrollTop + e.clientHeight >= e.scrollHeight - 1)).toBe(true);
  const notice = page.locator('.task-pair-card-notice');
  await notice.evaluate(e => { e.scrollTop = e.scrollHeight; });
  expect(await notice.evaluate(e => e.scrollTop + e.clientHeight >= e.scrollHeight - 1)).toBe(true);
  await notice.hover(); const outer = page.locator('.chat-view');
  // Stay in the mounted virtual range. A jump to zero can unmount the card;
  // at the tail, merely checking scrollTop > 0 does not prove a wheel moved.
  await page.evaluate(() => { (window as any).__retainedPairCard = document.querySelector('.task-pair-event-card'); });
  await outer.hover({ position: { x: 2, y: 100 } });
  const tail = await outer.evaluate(e => e.scrollTop);
  await page.mouse.wheel(0, -80);
  await expect.poll(() => outer.evaluate(e => e.scrollTop)).toBeLessThan(tail - 20);
  const wheelBefore = await outer.evaluate(e => e.scrollTop);
  await page.mouse.wheel(0, 50);
  await expect.poll(() => outer.evaluate(e => e.scrollTop)).toBeGreaterThan(wheelBefore + 20);
  const wheelAfter = await outer.evaluate(e => e.scrollTop);
  const retained = () => page.evaluate(() => {
    const old = (window as any).__retainedPairCard;
    return Boolean(old?.isConnected && old === document.querySelector('.task-pair-event-card') && old.classList.contains('is-expanded'));
  });
  expect(await retained()).toBe(true);
  await info.attach('real-outer-wheel', { body: JSON.stringify({ tail, wheelBefore, wheelAfter, delta: wheelAfter - wheelBefore }), contentType: 'application/json' });
  for (const viewport of [{ width: 640, height: 390 }, { width: 390, height: 420 }, { width: 720, height: 500 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await expectContained(page); expect(await retained()).toBe(true);
  }
  // Browser-style 200% page zoom has half the CSS viewport width; additionally
  // exercise CSS zoom at the production root (including controls and content).
  await page.evaluate(() => { document.querySelector<HTMLElement>('#fixture-root')!.style.zoom = '2'; });
  await page.setViewportSize({ width: 780, height: 844 });
  await page.evaluate(() => { document.querySelector<HTMLElement>('#chat-timeline-fixture-harness')!.style.width = '50vw'; document.querySelector<HTMLElement>('.chat-timeline-fixture-window')!.style.width = '50vw'; });
  const zoomed = await geometry(page); expect(zoomed.documentOverflow).toBe(false);
  expect(zoomed.scrollWidth).toBeLessThanOrEqual(zoomed.clientWidth + 1);
  expect(zoomed.audit!.x).toBeCloseTo(zoomed.body.x, 0);
  await page.evaluate(() => { document.querySelector<HTMLElement>('#fixture-root')!.style.zoom = ''; document.querySelector<HTMLElement>('#chat-timeline-fixture-harness')!.style.width = ''; document.querySelector<HTMLElement>('.chat-timeline-fixture-window')!.style.width = ''; });
  await page.setViewportSize({ width: 390, height: 844 });
  // Retained window receives stream/history changes while hidden, then resumes.
  await page.locator('.chat-timeline-fixture-window').evaluate(e => { e.style.visibility = 'hidden'; });
  for (let i = 0; i < 20; i++) await publish(page, [...preceding, linkedUser, memory, { ...target, payload: { ...target.payload, summary: SUMMARY + ` stream ${i}` } }]);
  await page.locator('.chat-timeline-fixture-window').evaluate(e => { e.style.visibility = ''; });
  await expectContained(page); expect(await page.evaluate(() => (window as any).__requests)).toBe(1);
  await page.locator('.task-pair-card-role .task-pair-chip-session').first().click();
  expect(await page.evaluate(() => (window as any).__navigated)).toEqual(['deck_fixture_executor_long_canonical_name']);
  await page.locator('.task-pair-card-role .task-pair-chip-session').last().click();
  expect(await page.evaluate(() => (window as any).__navigated)).toEqual(['deck_fixture_executor_long_canonical_name', 'deck_fixture_auditor_long_canonical_name']);
  await page.screenshot({ path: info.outputPath('native-long-chat.png') });
  await page.locator('.task-pair-card-toggle').click();
  await expect(page.locator('.task-pair-card-body')).toHaveCount(0);
});

test('independent checklist, empty audit, no-auditor and visit scope remain usable', async ({ page }) => {
  await open(page, 393, 'en', '&scope=1&visit=fixture-visit');
  await publish(page, [pair({ executor: 'fixture-window-0', auditor: 'none', summary: undefined, verb: 'WORKING', toStatus: 'working', brief: 'Goal\nSynthetic brief\n- [x][ ] 1. Synthetic checklist row' })]);
  await expect(page.locator('.task-pair-status-panel')).toHaveClass(/is-collapsed/);
  await page.locator('.task-pair-status-compact').click();
  await page.locator('.task-pair-brief-checklist-toggle').click();
  await expect(page.locator('.task-pair-brief-checklist-panel')).toBeVisible();
  await expect(page.locator('.task-pair-brief-checklist-row input')).toHaveCount(2);
  await expect(page.locator('.task-pair-brief-checklist-toggle')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('.task-pair-status-toggle').click();
  await page.locator('.task-pair-card-toggle').click();
  await expect(page.locator('.task-pair-card-audit-details')).toHaveCount(0);
  await expectContained(page);
  await page.reload(); await page.waitForFunction(() => (window as any).__chatTimelineHarness?.ready);
  await publish(page, [pair({ executor: 'fixture-window-0', auditor: 'none', summary: undefined })]);
  await expect(page.locator('.task-pair-status-panel')).toHaveClass(/is-collapsed/);
});

for (const width of [320, 390, 393]) {
  test(`large counts, delayed actions and hotzone boundaries at ${width}px`, async ({ page }) => {
    await open(page, width, 'ru', '&branch=synthetic-long-branch-name-for-layout');
    await publish(page, [pair()]);
    await snapshot(page, [111, 222, 333, 444]);
    const g = await stripGeometry(page);
    for (const c of g.counts) expect(c.right, JSON.stringify(g)).toBeLessThanOrEqual(g.content.right + 1);
    expect(g.strip.right).toBeLessThan(g.actions.x);
    expect(g.titlebar.height).toBe(33);
    // Inspect actual hit testing at every neighbor center; the compact ::before
    // must not win a click outside its own horizontal allocation.
    const hits = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.chat-titlebar > :not(.task-pair-status-panel) button, .chat-top-actions button')].map(button => {
      const r = button.getBoundingClientRect(); const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return button.contains(at);
    }));
    expect(hits.every(Boolean)).toBe(true);
    await page.locator('.session-repo-branch-summary').click();
    await expect(page.locator('.task-pair-status-panel')).toHaveClass(/is-collapsed/);
    // Actual control removal/reappearance exercises the production ResizeObserver
    // reservation, including its late first measurement.
    await page.locator('.chat-top-actions').evaluate(e => { e.style.display = 'none'; });
    await page.waitForTimeout(80);
    const hidden = await stripGeometry(page);
    for (const c of hidden.counts) expect(c.right).toBeLessThanOrEqual(hidden.content.right + 1);
    await page.locator('.chat-top-actions').evaluate(e => { e.style.display = ''; });
    await page.setViewportSize({ width: 640, height: 390 });
    await page.setViewportSize({ width, height: 420 });
    const restored = await stripGeometry(page);
    for (const c of restored.counts) expect(c.right).toBeLessThanOrEqual(restored.content.right + 1);
    expect(restored.strip.right).toBeLessThan(restored.actions.x);
  });
}

test('separate tasks with equal role labels do not share expansion or navigation identity', async ({ page }) => {
  await open(page);
  await publish(page, [pair({ executor: 'deck_fixture_executor_a' }, 'task-a'), pair({ executor: 'deck_fixture_executor_b' }, 'task-b')]);
  await page.locator('[data-task-id="task-a"] .task-pair-card-toggle').click();
  await expect(page.locator('[data-task-id="task-a"] .task-pair-card-body')).toBeVisible();
  await expect(page.locator('[data-task-id="task-b"] .task-pair-card-body')).toHaveCount(0);
  await publish(page, [pair({ executor: 'deck_fixture_executor_b' }, 'task-b')]);
  await expect(page.locator('.task-pair-card-body')).toHaveCount(0);
  await page.locator('.task-pair-card-toggle').click(); await expectContained(page);
});

for (const width of [320, 390, 1280]) {
  test(`concrete Pair actions and absent unknown rows at ${width}px`, async ({ page }, info) => {
    await open(page, width, 'zh-CN');
    await page.evaluate(() => {
      (window as any).__actionRequests = 0;
      window.addEventListener('fixture:decision-request', () => (window as any).__actionRequests++);
    });
    const samples = [
      { verb: 'CHECK', label: '验收项已更新' },
      { verb: 'CLAIM', label: '资源占用已更新' },
      { verb: 'SEND', label: '任务消息已发送' },
      { verb: 'TITLE', label: '任务标题已更新' },
      { verb: 'DECISION_REQUEST', label: '决策信息已更新' },
      { verb: 'WORKSPACE', effect: 'output_failed', label: '产物保存失败' },
      { verb: 'FUTURE_EVENT', label: undefined },
      { verb: undefined, label: undefined },
    ];
    const measurements: unknown[] = [];
    for (const sample of samples) {
      const { label, ...fields } = sample;
      const input = pair({ ...fields, writer: '', summary: undefined, toStatus: 'working', password: 'fixture-secret', diagnostic: 'Safe <&> detail', executorModel:'fixture-model', auditorModel:'fixture-model' });
      await publish(page, [input]);
      const toggle = page.locator('.task-pair-card-toggle');
      if (await toggle.getAttribute('aria-expanded') === 'true') await toggle.click();
      const compact = (await page.locator('.task-pair-event-card').boundingBox())!.height;
      // Capture before action assertions, so the exact-base control records
      // identical-payload dimensions even when old labels fail.
      measurements.push({ verb: fields.verb ?? null, compact });
      await info.attach(`compact-${fields.verb || 'missing'}`, { body:JSON.stringify({width,verb:fields.verb ?? null,compact}), contentType:'application/json' });
      if (width === 1280) {
        await page.mouse.move(1,1);
        await page.locator('.task-pair-title-preview-trigger').hover();
        await expect(page.locator('.task-pair-card-hover-preview')).toBeVisible();
        await expect(page.locator('.task-pair-card-hover-preview')).toHaveCSS('opacity','1');
        const row = page.locator('.task-pair-card-hover-preview-event');
        if (label) await expect(row).toHaveText(label);
        else await expect(row).toHaveCount(0);
        await page.screenshot({path:info.outputPath(`hover-${fields.verb || 'missing'}.png`)});
        await page.locator('.task-pair-card-hover-preview .task-pair-chip-session').first().focus();
        await page.keyboard.press('Escape');
        await expect(page.locator('.task-pair-card-hover-preview')).toHaveCount(0);
        await toggle.focus();
        await page.keyboard.press('ArrowDown');
        await expect(page.locator('.task-pair-card-hover-preview')).toBeVisible();
        await expect(page.locator('.task-pair-card-hover-preview')).toHaveCSS('opacity','1');
        await page.locator('.task-pair-card-hover-preview .task-pair-chip-session').first().focus();
        await page.keyboard.press('Escape');
      }
      if (width > 720) {
        const overview = page.locator('.task-pair-card-overview > .task-pair-card-event-meta');
        if (label) await expect(overview).toHaveText(label);
        else await expect(overview).toHaveCount(0);
      }
      await page.screenshot({path:info.outputPath(`compact-${fields.verb || 'missing'}.png`)});
      await toggle.click();
      if (label) {
        await expect(page.locator('.task-pair-chip-text')).toContainText(fields.verb === 'WORKSPACE' ? '成果未保存' : label);
        await expect(page.locator('.task-pair-card-body > .task-pair-card-event-meta')).toContainText(label);
      } else {
        await expect(page.locator('.task-pair-chip-text')).toHaveCount(0);
        await expect(page.locator('.task-pair-card-body > .task-pair-card-event-meta')).toHaveCount(0);
      }
      await expect(page.locator('.task-pair-event-card')).not.toContainText(/taskPair\.verb|已记录|undefined/);
      await expect(page.locator('.task-pair-chip-status')).toContainText('执行中');
      await expect(page.locator('.task-pair-card-role')).toHaveCount(2);
      if (width <= 720) await expectContained(page);
      await page.locator('.task-pair-card-payload summary').click();
      const payload = page.locator('.task-pair-card-payload pre');
      await expect(payload).toContainText('Safe <&> detail');
      await expect(payload).not.toContainText('fixture-secret');
      await page.screenshot({path:info.outputPath(`expanded-${fields.verb || 'missing'}.png`)});
      const requests = await page.evaluate(() => (window as any).__actionRequests);
      for (let i = 0; i < 3; i++) await publish(page, [{...input,payload:{...input.payload,diagnostic:`Safe redraw ${i}`}}]);
      expect(await page.evaluate(() => (window as any).__actionRequests)).toBe(requests);
      await toggle.click();
      expect((await page.locator('.task-pair-event-card').boundingBox())!.height).toBeCloseTo(compact, 0);
    }
    await info.attach('action-dimensions', { body:JSON.stringify(measurements), contentType:'application/json' });
  });
}

test('Pair action compact dimensions remain bounded for identical payloads', async ({ page }, info) => {
  const dimensions: unknown[] = [];
  for (const width of [320,390,1280]) {
    await open(page,width,'zh-CN');
    for (const verb of ['CHECK','CLAIM','SEND','TITLE','DECISION_REQUEST','WORKSPACE','FUTURE_EVENT',null]) {
      await publish(page,[pair({verb,effect:'output_failed',writer:'',summary:undefined,toStatus:'working',executorModel:'fixture-model',auditorModel:'fixture-model'})]);
      const card = page.locator('.task-pair-event-card');
      dimensions.push({width,verb,compact:(await card.boundingBox())!.height});
      if (width <= 720) expect((await card.boundingBox())!.height).toBeLessThanOrEqual(width === 320 ? 97 : 65);
      if (width === 1280) {
        await page.locator('.task-pair-title-preview-trigger').hover();
        await expect(page.locator('.task-pair-card-hover-preview')).toBeVisible();
        await expect(page.locator('.task-pair-card-hover-preview')).toHaveCSS('opacity','1');
        dimensions.push({width,verb,hover:(await page.locator('.task-pair-card-hover-preview').boundingBox())!.height});
        await page.mouse.move(1,1);
        await expect(page.locator('.task-pair-card-hover-preview')).toHaveCount(0);
      }
    }
  }
  await info.attach('identical-payload-dimensions',{body:JSON.stringify(dimensions),contentType:'application/json'});
});

test('title-only preview rejects non-title hover and mouse focus, supports portal and keyboard', async ({ page }, info) => {
  await open(page,1280,'en');
  await publish(page,[pair({title:'Short title',summary:undefined})]);
  await page.evaluate(()=>{(window as any).__titlePreviewQueries=0;window.addEventListener('fixture:decision-request',()=>{(window as any).__titlePreviewQueries++;});});
  const toggle=page.locator('.task-pair-card-toggle');
  for(const selector of ['.task-pair-card-kicker','.task-pair-chip-status','.task-pair-card-time','.task-pair-card-chevron','.task-pair-card-overview','.task-pair-card-role']) {
    await page.locator(selector).first().hover();await page.waitForTimeout(250);
    await expect(page.locator('.task-pair-card-hover-preview')).toHaveCount(0);
  }
  await toggle.focus();await page.waitForTimeout(250);
  await expect(page.locator('.task-pair-card-hover-preview')).toHaveCount(0);
  const cell=await page.locator('.task-pair-chip-task').boundingBox();
  const title=page.locator('.task-pair-title-preview-trigger');const tb=await title.boundingBox();
  expect(cell!.width).toBeGreaterThan(tb!.width+20);
  await page.mouse.move(cell!.x+cell!.width-2,cell!.y+cell!.height/2);await page.waitForTimeout(250);
  await expect(page.locator('.task-pair-card-hover-preview')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__titlePreviewQueries)).toBe(0);
  await page.locator('.task-pair-title-preview-icon').hover();
  const preview=page.locator('.task-pair-card-hover-preview');
  await expect(preview).toBeVisible();await expect(preview).toHaveCSS('opacity','1');
  await page.screenshot({path:info.outputPath('title-icon-preview.png')});
  await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});
  await page.keyboard.press('Escape');await expect(preview).toHaveCount(0);
  await page.mouse.move(1,1);await title.hover();await expect(preview).toBeVisible();
  await preview.hover();await page.waitForTimeout(200);await expect(preview).toBeVisible();
  await page.evaluate(()=>{(window as any).__previewNav=[];window.addEventListener('deck:navigate',(e:any)=>(window as any).__previewNav.push(e.detail.session));});
  await preview.locator('.task-pair-chip-session').first().click();
  expect(await page.evaluate(()=>(window as any).__previewNav)).toEqual(['deck_fixture_executor']);
  await page.mouse.move(1,1);await expect(preview).toHaveCount(0);
  await toggle.focus();await page.keyboard.press('ArrowDown');await expect(preview).toBeFocused();
  await page.keyboard.press('Tab');await expect(preview.locator('.task-pair-chip-session').first()).toBeFocused();
  await page.keyboard.press('Escape');await expect(preview).toHaveCount(0);await expect(toggle).toBeFocused();
  const intentionalRequests=await page.evaluate(()=>(window as any).__titlePreviewQueries);
  expect(intentionalRequests).toBeLessThanOrEqual(3);
  for(let i=0;i<5;i++)await publish(page,[pair({title:'Short title',summary:`Stream ${i}`})]);
  expect(await page.evaluate(()=>(window as any).__titlePreviewQueries)).toBe(intentionalRequests);
  await page.keyboard.press('Enter');await expect(toggle).toHaveAttribute('aria-expanded','true');
  await page.locator('.task-pair-card-body').hover();await page.waitForTimeout(250);await expect(preview).toHaveCount(0);
  await page.keyboard.press('Escape'); // expanded card must not collapse
  await expect(toggle).toHaveAttribute('aria-expanded','true');await toggle.click();
  await page.mouse.move(1,1);await title.hover();await page.mouse.move(1,1);await page.waitForTimeout(300);await expect(preview).toHaveCount(0);
  await title.hover();await toggle.click();await page.waitForTimeout(300);await expect(preview).toHaveCount(0);
  await toggle.click();await page.mouse.move(1,1);await title.hover();
  await publish(page,[]);await page.waitForTimeout(300);await expect(preview).toHaveCount(0);
});

test('non-title card padding does not preview on the exact base causal control', async ({page})=>{
  await open(page,1280,'en');await publish(page,[pair()]);
  const card=await page.locator('.task-pair-event-card').boundingBox();
  await page.mouse.move(card!.x+2,card!.y+card!.height/2);await page.waitForTimeout(300);
  await expect(page.locator('.task-pair-card-hover-preview')).toHaveCount(0);
});

test('touch title tap expands without preview or an extra interactive descendant', async ({browser,baseURL})=>{
  const context=await browser.newContext({baseURL,hasTouch:true,isMobile:true,viewport:{width:390,height:844}});
  const page=await context.newPage();
  try {
    await open(page,390,'zh-CN');await publish(page,[pair()]);
    await expect(page.locator('.task-pair-card-toggle button, .task-pair-card-toggle [tabindex]')).toHaveCount(0);
    await page.locator('.task-pair-title-preview-icon').tap();
    await expect(page.locator('.task-pair-card-toggle')).toHaveAttribute('aria-expanded','true');
    await page.waitForTimeout(300);await expect(page.locator('.task-pair-card-hover-preview')).toHaveCount(0);
    await page.locator('.task-pair-chip-task strong').tap();
    await expect(page.locator('.task-pair-card-toggle')).toHaveAttribute('aria-expanded','false');
  } finally {await context.close();}
});

test('title preview geometry for short, long, fallback and normal titles', async ({page},info)=>{
  const dimensions:unknown[]=[];
  for(const width of [320,390,1280]) {
    await open(page,width,'zh-CN');
    for(const [kind,title] of [['short','Short title'],['fallback',undefined],['normal','Synthetic review and input controls'],['long','超长标题 Longer title <&> '.repeat(20)]] as const) {
      await publish(page,[pair({title,summary:undefined})]);
      const card=page.locator('.task-pair-event-card');
      const size=await card.boundingBox();
      dimensions.push({width,kind,height:size!.height});
      await info.attach(`title-dimension-${width}-${kind}`,{body:JSON.stringify({width,kind,height:size!.height}),contentType:'application/json'});
      const bounds=await card.evaluate(e=>({scroll:e.scrollWidth,client:e.clientWidth,title:[...e.querySelectorAll('.task-pair-chip-task,.task-pair-chip-task strong')].map(n=>({width:n.getBoundingClientRect().width,css:getComputedStyle(n).cssText,flex:getComputedStyle(n).flex,min:getComputedStyle(n).minWidth,max:getComputedStyle(n).maxWidth,overflow:getComputedStyle(n).overflow}))}));
      expect(bounds.scroll<=bounds.client+1,JSON.stringify({width,kind,bounds})).toBe(true);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:info.outputPath(`${width}-${kind}.png`)});
    }
  }
  await info.attach('title-default-dimensions',{body:JSON.stringify(dimensions),contentType:'application/json'});
});

for (const width of [320, 390, 1280]) {
  test(`status role pills show labels and models without internal IDs at ${width}px`, async ({ page }, info) => {
    await open(page, width, 'en');
    await page.evaluate(() => {
      (window as any).__statusNavigated = [];
      window.addEventListener('deck:navigate', (e: any) => (window as any).__statusNavigated.push(e.detail.session));
    });
    const executor = 'deck_sub_fixture_status_executor';
    const auditor = 'deck_sub_fixture_status_auditor';
    await publish(page, [pair({ verb: 'WORKING', toStatus: 'working', executor, auditor, executorLabel: 'Same display', auditorLabel: 'Same display', executorModel: 'Model E', auditorModel: 'Model A', executorState: 'running', auditorState: 'running' })]);
    const panel = page.locator('.task-pair-status-panel');
    if (await panel.evaluate(e => e.classList.contains('is-collapsed'))) await page.locator('.task-pair-status-compact').click();
    const buttons = panel.locator('.task-pair-status-session');
    await expect(buttons).toHaveCount(2);
    const pills = await panel.locator('.task-pair-role-chip').evaluateAll(elements => elements.map(e => {
      const r = e.getBoundingClientRect(); return { text: e.textContent, height: r.height, width: r.width };
    }));
    await info.attach(`status-pill-dimensions-${width}`, { body: JSON.stringify(pills), contentType: 'application/json' });
    for (const [i, id] of [executor, auditor].entries()) {
      const button = buttons.nth(i);
      await expect(button).toHaveText(`Same displayModel ${i ? 'A' : 'E'}`);
      await expect(button).toHaveAttribute('data-session-name', id);
      expect(await button.getAttribute('title') || '').not.toContain(id);
      expect(await button.getAttribute('aria-label') || '').not.toContain(id);
      await button.click();
    }
    expect(await page.evaluate(() => (window as any).__statusNavigated)).toEqual([executor, auditor]);
    await expect(panel.locator('.task-pair-status-session-id')).toHaveCount(0);
    await expect(panel.locator('.task-pair-status-dot.is-running')).toHaveCount(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: info.outputPath(`status-label-model-${width}.png`) });
    await publish(page, [pair({ verb: 'WORKING', toStatus: 'working', executor: 'deck_sub_unlabeled_status', auditor: 'none', executorLabel: undefined, auditorLabel: undefined, executorModel: undefined, auditorModel: undefined }, 'status-unlabeled')]);
    const fallback = panel.locator('.task-pair-status-session');
    await expect(fallback).toHaveCount(1);
    await expect(fallback).toHaveText('Executor');
    await expect(fallback).toHaveAttribute('data-session-name', 'deck_sub_unlabeled_status');
    await expect(fallback.locator('.task-pair-status-session-model')).toHaveCount(0);
  });
}
