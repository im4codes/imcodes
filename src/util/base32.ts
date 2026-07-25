/**
 * Minimal RFC 4648 base32 encoder, lowercase and unpadded.
 *
 * Node has no built-in base32 (`Buffer.toString` covers hex/base64/base64url
 * only), and pulling a dependency for ~15 lines isn't worth it. Output is
 * lowercase because callers normalize handles to lowercase; emitting it directly
 * avoids a case round-trip. The alphabet omits 0/1/8/9, so base32 handles stay
 * reasonably unambiguous when read off a screen.
 */
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function encodeBase32(bytes: Uint8Array): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    // `bits` is drained below 5 on every iteration, so `value` never exceeds
    // 20 significant bits — well inside the 32-bit range of `<<`/`>>>`.
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
