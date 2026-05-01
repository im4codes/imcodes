import { describe, expect, it } from 'vitest';
import { MEMORY_DEFAULTS } from '../../shared/memory-defaults.js';
import { renderMemoryContextItem, renderMemoryContextItems } from '../../shared/memory-render-policy.js';
import { MemoryTelemetryBuffer } from '../../shared/memory-telemetry.js';
import { SKILL_ENVELOPE_CLOSE, SKILL_ENVELOPE_OPEN } from '../../shared/skill-envelope.js';

describe('memory render policy', () => {
  it('keeps pinned content verbatim while trimming normal summaries', () => {
    expect(renderMemoryContextItem({ kind: 'pinned', content: '  Keep exact\nspacing  ', maxBytes: 4 })).toEqual({
      ok: true,
      kind: 'pinned',
      text: '  Keep exact\nspacing  ',
    });
    expect(renderMemoryContextItem({ kind: 'summary', content: ' abcdef ', maxBytes: 3 })).toMatchObject({
      ok: true,
      text: 'abc',
    });
  });

  it('envelopes skills and applies the shared skill cap/collision policy', () => {
    const rendered = renderMemoryContextItem({ kind: 'skill', content: 'Use tests.' });
    expect(rendered).toMatchObject({ ok: true, kind: 'skill' });
    expect(rendered.text).toContain(SKILL_ENVELOPE_OPEN);
    expect(rendered.text).toContain(SKILL_ENVELOPE_CLOSE);
    expect(rendered.text).toContain('Use tests.');

    const oversized = renderMemoryContextItem({ kind: 'skill', content: '好'.repeat(MEMORY_DEFAULTS.skillMaxBytes) });
    expect(oversized.ok).toBe(true);
    expect(new TextEncoder().encode(oversized.text).byteLength).toBeLessThanOrEqual(
      MEMORY_DEFAULTS.skillMaxBytes + new TextEncoder().encode(`${SKILL_ENVELOPE_OPEN}\n\n${SKILL_ENVELOPE_CLOSE}`).byteLength,
    );
  });

  it('omits unauthorized citation previews instead of leaking raw source', () => {
    expect(renderMemoryContextItem({
      kind: 'citation_preview',
      content: 'raw private source',
      authorizedRawSource: false,
    })).toEqual({
      ok: false,
      kind: 'citation_preview',
      text: '',
      reason: 'unauthorized_citation_preview',
    });
    expect(renderMemoryContextItem({
      kind: 'citation_preview',
      content: 'authorized source preview',
      authorizedRawSource: true,
      maxBytes: 10,
    })).toMatchObject({ ok: true, text: 'authorized' });
  });

  it('drops one failed render item with telemetry without failing the whole payload', () => {
    const dropped: string[] = [];
    const telemetry = new MemoryTelemetryBuffer({
      sink: { record: (event) => dropped.push(`${event.counter}:${event.labels.reason}`) },
    });

    const rendered = renderMemoryContextItems([
      { kind: 'summary', content: ' keep ' },
      { kind: 'citation_preview', content: 'private raw source', authorizedRawSource: false },
      { kind: 'note', content: 'next item' },
    ], { telemetry });

    expect(rendered).toEqual(['keep', 'next item']);
    expect(dropped).toEqual(['mem.startup.stage_dropped:render_failed']);
  });
});
