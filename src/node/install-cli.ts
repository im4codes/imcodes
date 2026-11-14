import {
  CONTROLLED_NODE_ENROLL_STDIN_FLAG,
  CONTROLLED_NODE_ENROLL_STDIN_MAX_BYTES,
  CONTROLLED_NODE_INSTALL_SUBCOMMAND,
  parseEnrollmentPayloadJson,
} from '../../shared/controlled-node-install.js';
import type { EnrollmentBlob } from '../../shared/remote-exec.js';

/**
 * Inspect `process.argv` for the `install --enroll-stdin` subcommand.
 * Returns `true` when stdin-based enrollment is requested, `false` for other modes,
 * and throws fail-closed on unsupported flags or extra arguments (never accepting
 * tokens via CLI arguments).
 */
export function parseInstallSubcommandArgs(argv: readonly string[]): boolean {
  if (argv[2] !== CONTROLLED_NODE_INSTALL_SUBCOMMAND) {
    return false;
  }
  if (argv.length !== 4 || argv[3] !== CONTROLLED_NODE_ENROLL_STDIN_FLAG) {
    throw new Error(`usage: imcodes-node ${CONTROLLED_NODE_INSTALL_SUBCOMMAND} ${CONTROLLED_NODE_ENROLL_STDIN_FLAG}`);
  }
  return true;
}

/**
 * Read a bounded UTF-8 JSON enrollment payload from stdin and validate it against
 * the shared schema. Never echoes raw stdin or secret tokens in error messages.
 */
export async function readEnrollmentBlobFromStdin(
  stream: AsyncIterable<Buffer | string> = process.stdin,
  maxBytes = CONTROLLED_NODE_ENROLL_STDIN_MAX_BYTES,
): Promise<EnrollmentBlob> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const rawChunk of stream) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk, 'utf8');
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw new Error('enrollment stdin payload exceeds maximum allowed size');
    }
    chunks.push(chunk);
  }
  const rawText = Buffer.concat(chunks, totalBytes).toString('utf8');
  const validated = parseEnrollmentPayloadJson(rawText, maxBytes);
  if (!validated.ok) {
    throw new Error(`invalid enrollment stdin payload (${validated.error})`);
  }
  return validated.value;
}
