import { redactObject, type Redactable } from './logging/redact.js';
import { redactSensitiveText } from './redact-secrets.js';

export interface P2pWorkflowRedactionOptions {
  rawCaptureMaxBytes: number;
  projectionSnippetMaxBytes: number;
  extraPatterns?: RegExp[];
}

const DEFAULT_REDACTION_OPTIONS: P2pWorkflowRedactionOptions = {
  rawCaptureMaxBytes: 512 * 1024,
  projectionSnippetMaxBytes: 16 * 1024,
};

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

export function redactP2pWorkflowTextForProjection(
  rawText: string,
  options: Partial<P2pWorkflowRedactionOptions> = {},
): string {
  const resolved = { ...DEFAULT_REDACTION_OPTIONS, ...options };
  const captured = truncateUtf8(rawText, resolved.rawCaptureMaxBytes);
  const redacted = redactSensitiveText(captured, resolved.extraPatterns);
  return truncateUtf8(redacted, resolved.projectionSnippetMaxBytes);
}

export function redactP2pWorkflowObjectForProjection<T extends Redactable>(value: T): Redactable {
  return redactObject(value);
}
