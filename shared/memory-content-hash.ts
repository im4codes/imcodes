import { createHash } from 'node:crypto';

export function stableJson(value: unknown): string {
  if (value == null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export function sha256Text(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function computeProjectionContentHash(input: { summary: string; content: unknown }): string {
  return sha256Text(`projection-content:v1:${input.summary.trim()}\n${stableJson(input.content)}`);
}
