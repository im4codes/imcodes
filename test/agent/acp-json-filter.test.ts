import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { filterAcpJsonLines } from '../../src/agent/providers/acp-json-filter.js';

/** Explicit byte-mode Readable so chunk boundaries are exactly as specified. */
function byteSource(chunks: Array<string | Buffer>): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (i < chunks.length) {
        const c = chunks[i++];
        this.push(Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'));
      } else {
        this.push(null);
      }
    },
  });
}

async function collect(readable: Readable): Promise<string> {
  const out: Buffer[] = [];
  for await (const c of readable) out.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(out).toString('utf8');
}

describe('filterAcpJsonLines', () => {
  it('passes JSON object/array lines and drops non-JSON noise (e.g. the gemini untrusted-folder banner)', async () => {
    const dropped: string[] = [];
    const src = byteSource([
      '{"jsonrpc":"2.0","id":1}\n',
      'Skipping project agents due to untrusted folder. To enable, ensure that the project root is trusted.\n',
      '[1,2,3]\n',
      'Some deprecation warning text\n',
      '{"method":"session/update"}\n',
    ]);
    const out = await collect(filterAcpJsonLines(src, (line) => dropped.push(line)));
    expect(out.split('\n').filter(Boolean)).toEqual([
      '{"jsonrpc":"2.0","id":1}',
      '[1,2,3]',
      '{"method":"session/update"}',
    ]);
    expect(dropped).toEqual([
      'Skipping project agents due to untrusted folder. To enable, ensure that the project root is trusted.',
      'Some deprecation warning text',
    ]);
  });

  it('reassembles a JSON line split across chunk boundaries mid-multibyte-codepoint', async () => {
    const dropped: string[] = [];
    const full = '{"text":"你好world"}\n';
    const buf = Buffer.from(full, 'utf8');
    // Byte 11 lands inside the 3-byte 你 codepoint (`{"text":"` is 9 bytes).
    const src = byteSource([buf.subarray(0, 11), buf.subarray(11)]);
    const out = await collect(filterAcpJsonLines(src, (l) => dropped.push(l)));
    expect(out).toBe(full);
    expect(JSON.parse(out.trim())).toEqual({ text: '你好world' });
    expect(dropped).toEqual([]);
  });

  it('drops a non-JSON line split across chunks and emits a trailing JSON line that has no newline', async () => {
    const dropped: string[] = [];
    const src = byteSource([
      'Skipping project ',
      'agents due to untrusted folder\n{"ok":true}',
    ]);
    const out = await collect(filterAcpJsonLines(src, (l) => dropped.push(l)));
    expect(out.split('\n').filter(Boolean)).toEqual(['{"ok":true}']);
    expect(dropped).toEqual(['Skipping project agents due to untrusted folder']);
  });

  it('passes blank/whitespace-only lines through without counting them as drops', async () => {
    const dropped: string[] = [];
    const src = byteSource(['{"a":1}\n', '\n', '   \n', '{"b":2}\n']);
    const out = await collect(filterAcpJsonLines(src, (l) => dropped.push(l)));
    expect(out.split('\n').filter((l) => l.trim()).map((l) => l.trim())).toEqual(['{"a":1}', '{"b":2}']);
    expect(dropped).toEqual([]);
  });

  it('reports a monotonically increasing drop count to onDrop', async () => {
    const counts: number[] = [];
    const src = byteSource(['noise 1\n', '{"x":1}\n', 'noise 2\n', 'noise 3\n']);
    await collect(filterAcpJsonLines(src, (_line, n) => counts.push(n)));
    expect(counts).toEqual([1, 2, 3]);
  });
});
