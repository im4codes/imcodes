import LinkifyIt from 'linkify-it';

const linkify = new LinkifyIt();

const URL_HARD_STOP_REGEX = /[（【《「『，。；：！？⬇]/u;
const URL_TRAILING_PUNCTUATION_REGEX = /[.,;:!?)}\]>）】》」』，。；：！？⬇]$/u;

export interface HttpUrlChunk {
  type: 'text' | 'url';
  value: string;
  start: number;
}

export function trimDetectedUrl(url: string): string {
  const hardStop = url.search(URL_HARD_STOP_REGEX);
  let next = hardStop >= 0 ? url.slice(0, hardStop) : url;
  while (next.length > 1 && URL_TRAILING_PUNCTUATION_REGEX.test(next)) {
    next = next.slice(0, -1);
  }
  return next;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function splitTextByHttpUrls(text: string): HttpUrlChunk[] {
  const matches = linkify.match(text) ?? [];
  const chunks: HttpUrlChunk[] = [];
  let last = 0;

  for (const match of matches) {
    if (!isHttpUrl(match.raw)) continue;

    const url = trimDetectedUrl(match.raw);
    if (!url) continue;

    const start = match.index;
    const end = start + url.length;
    if (start < last) continue;

    if (start > last) chunks.push({ type: 'text', value: text.slice(last, start), start: last });
    chunks.push({ type: 'url', value: url, start });
    last = end;
  }

  if (last < text.length) chunks.push({ type: 'text', value: text.slice(last), start: last });
  return chunks.length ? chunks : [{ type: 'text', value: text, start: 0 }];
}
