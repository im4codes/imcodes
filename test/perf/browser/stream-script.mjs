/**
 * Shared streaming fixtures for the flicker probes: the ChatView fixture driver
 * (chat-scroll-fixture.spec.mjs, runs in the page) and the many-windows fake
 * daemon (daemon-client.mjs) stream the SAME Markdown-heavy reply with the SAME
 * bursty arrival pattern, so base and head see identical input.
 */

/** A Markdown-heavy reply as in the owner's recording: heading, ---, **bold**, lists, inline code. */
export const MD_STREAM_SCRIPT = [
  '好的，这次换一篇不同题材的。',
  '',
  '---',
  '',
  '**深夜的便利店**',
  '',
  '凌晨一点四十分，便利店的自动门"叮咚"响了一声。值班的小陈抬起头，进来的是个穿西装的中年男人。',
  '',
  '## 他买了什么',
  '',
  '- 一盒**饭团**',
  '- 一瓶 `无糖` 茶',
  '- 一包烟，没有拆封',
  '',
  '1. 先是沉默',
  '2. 然后他说：**"能借用一下微波炉吗？"**',
  '',
  '收银台旁边的灯管一直在闪，像是在替谁数着时间。',
  '',
].join('\n');

/**
 * Deterministic (mulberry32) inter-chunk delays in ms for a token stream that
 * arrives in bursts: 3-6 chunks 20 ms apart, then a 150-350 ms pause.
 */
export function burstyGaps(count = 2048) {
  let seed = 0x9e3779b9;
  const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gaps = [];
  while (gaps.length < count) {
    const burst = 2 + Math.floor(rand() * 4);
    for (let i = 0; i < burst; i += 1) gaps.push(20);
    gaps.push(150 + Math.floor(rand() * 200));
  }
  return gaps.slice(0, count);
}

/** Token-sized piece lengths (characters), cycled by chunk number. */
export const MD_PIECE_LENGTHS = [2, 3, 4, 5, 6, 7];

/** Piece n of the script starting at `position`. */
export function nextMarkdownPiece(position, n) {
  const len = MD_PIECE_LENGTHS[n % MD_PIECE_LENGTHS.length];
  const piece = MD_STREAM_SCRIPT.slice(position, position + len);
  return { piece: piece || ' ', position: (position + len) % MD_STREAM_SCRIPT.length };
}
