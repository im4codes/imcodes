import { describe, expect, it } from 'vitest';
import {
  decodeEnrollmentTrailerWithRange,
  encodeEnrollmentTrailer,
} from '../../shared/remote-exec.js';
import {
  buildWindowsAuthenticodeEnrollmentPlan,
  inspectWindowsAuthenticodeEnrollmentContainer,
  parseWindowsPeSecurityDirectory,
} from '../../shared/windows-authenticode-enrollment.js';

function signedPeFixture(): Buffer {
  const certificateOffset = 512;
  const certificateSize = 16;
  const file = Buffer.alloc(certificateOffset + certificateSize, 0x5a);
  file.writeUInt32LE(0x80, 0x3c);
  file.writeUInt32LE(0x00004550, 0x80);
  const optional = 0x80 + 24;
  file.writeUInt16LE(0x20b, optional);
  file.writeUInt32LE(16, optional + 108);
  const securityEntry = optional + 112 + 4 * 8;
  file.writeUInt32LE(certificateOffset, securityEntry);
  file.writeUInt32LE(certificateSize, securityEntry + 4);
  file.writeUInt32LE(certificateSize, certificateOffset);
  file.writeUInt16LE(0x0200, certificateOffset + 4);
  file.writeUInt16LE(0x0002, certificateOffset + 6);
  return file;
}

function personalize(original: Buffer) {
  const trailer = encodeEnrollmentTrailer({
    serverUrl: 'https://im.example',
    enrollToken: 'ticket-123',
  });
  const plan = buildWindowsAuthenticodeEnrollmentPlan(original, original.length, trailer);
  if (!plan) throw new Error('fixture plan failed');
  const personalized = Buffer.concat([Buffer.from(original), plan.certificateEntry]);
  plan.patchedCertificateTableSize.copy(personalized, plan.sizeFieldOffset);
  return { trailer, plan, personalized };
}

describe('Windows Authenticode-preserving enrollment container', () => {
  it('embeds the enrollment trailer in a private certificate entry and restores exact signed bytes', () => {
    const original = signedPeFixture();
    const { trailer, plan, personalized } = personalize(original);
    expect(personalized).toHaveLength(plan.personalizedSize);
    const decoded = decodeEnrollmentTrailerWithRange(personalized);
    expect(decoded).toMatchObject({
      blob: { serverUrl: 'https://im.example', enrollToken: 'ticket-123' },
      trailerStart: plan.trailerStart,
      trailerLength: trailer.length,
    });
    const restore = inspectWindowsAuthenticodeEnrollmentContainer(
      personalized.subarray(0, Math.min(4096, personalized.length)),
      personalized.length,
      personalized,
      0,
      decoded!.trailerStart,
      decoded!.trailerLength,
    );
    expect(restore).not.toBeNull();
    const restored = Buffer.from(personalized.subarray(0, restore!.signedArtifactSize));
    restored.writeUInt32LE(restore!.originalCertificateTableSize, restore!.sizeFieldOffset);
    expect(restored).toEqual(original);
  });

  it('rejects unsigned, overlaid, misaligned, and structurally tampered inputs', () => {
    const original = signedPeFixture();
    const trailer = encodeEnrollmentTrailer({ serverUrl: 'https://im.example', enrollToken: 'x' });
    expect(buildWindowsAuthenticodeEnrollmentPlan(Buffer.alloc(528), 528, trailer)).toBeNull();

    const overlaid = Buffer.concat([original, Buffer.from('overlay')]);
    expect(buildWindowsAuthenticodeEnrollmentPlan(overlaid, overlaid.length, trailer)).toBeNull();

    const misaligned = Buffer.from(original);
    const directory = parseWindowsPeSecurityDirectory(original, original.length)!;
    misaligned.writeUInt32LE(directory.certificateTableOffset + 1, directory.sizeFieldOffset - 4);
    expect(buildWindowsAuthenticodeEnrollmentPlan(misaligned, misaligned.length, trailer)).toBeNull();

    const { personalized } = personalize(original);
    const decoded = decodeEnrollmentTrailerWithRange(personalized)!;
    const entryLength = personalized.length - original.length;
    const tampered = Buffer.from(personalized);
    tampered.writeUInt16LE(0xffff, original.length + 6);
    expect(inspectWindowsAuthenticodeEnrollmentContainer(
      tampered,
      tampered.length,
      tampered.subarray(tampered.length - entryLength),
      tampered.length - entryLength,
      decoded.trailerStart,
      decoded.trailerLength,
    )).toBeNull();
  });
});
