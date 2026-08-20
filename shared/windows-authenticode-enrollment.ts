/**
 * Authenticode-preserving personalization for Windows PE downloads.
 *
 * The PE security-directory entry and the certificate table it identifies are
 * excluded from the Authenticode image hash. A bounded, private WIN_CERTIFICATE
 * entry can therefore carry the one-time enrollment trailer without turning a
 * signed installer into "NotSigned". The installed service copy removes that
 * entry and restores the original directory size byte-for-byte.
 */

const PE_SIGNATURE = 0x00004550;
const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;
const SECURITY_DIRECTORY_INDEX = 4;
const WIN_CERT_REVISION_2_0 = 0x0200;
export const IMCODES_ENROLLMENT_CERTIFICATE_TYPE = 0x0ef1;
export const WINDOWS_AUTHENTICODE_ENROLLMENT_OVERHEAD_MAX = 15;

export interface WindowsPeSecurityDirectory {
  sizeFieldOffset: number;
  certificateTableOffset: number;
  certificateTableSize: number;
}

export interface WindowsAuthenticodeEnrollmentPlan {
  sizeFieldOffset: number;
  patchedCertificateTableSize: Buffer;
  certificateEntry: Buffer;
  trailerStart: number;
  personalizedSize: number;
}

export interface WindowsAuthenticodeEnrollmentRestore {
  signedArtifactSize: number;
  sizeFieldOffset: number;
  originalCertificateTableSize: number;
  certificateEntryLength: number;
}

export function parseWindowsPeSecurityDirectory(
  header: Buffer,
  fileSize: number,
): WindowsPeSecurityDirectory | null {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || header.length < 64) return null;
  const peOffset = header.readUInt32LE(0x3c);
  if (peOffset > 1024 * 1024 || peOffset + 26 > header.length) return null;
  if (header.readUInt32LE(peOffset) !== PE_SIGNATURE) return null;
  const optionalHeaderOffset = peOffset + 24;
  const magic = header.readUInt16LE(optionalHeaderOffset);
  const directoryOffset = magic === PE32_PLUS_MAGIC
    ? optionalHeaderOffset + 112
    : magic === PE32_MAGIC
      ? optionalHeaderOffset + 96
      : -1;
  const numberOfDirectoriesOffset = magic === PE32_PLUS_MAGIC
    ? optionalHeaderOffset + 108
    : optionalHeaderOffset + 92;
  if (directoryOffset < 0 || numberOfDirectoriesOffset + 4 > header.length
    || header.readUInt32LE(numberOfDirectoriesOffset) <= SECURITY_DIRECTORY_INDEX) return null;
  const securityEntryOffset = directoryOffset + SECURITY_DIRECTORY_INDEX * 8;
  if (securityEntryOffset + 8 > header.length) return null;
  const certificateTableOffset = header.readUInt32LE(securityEntryOffset);
  const certificateTableSize = header.readUInt32LE(securityEntryOffset + 4);
  if (certificateTableOffset <= 0 || certificateTableSize < 8
    || certificateTableOffset % 8 !== 0 || certificateTableSize % 8 !== 0
    || certificateTableOffset + certificateTableSize !== fileSize) return null;
  return {
    sizeFieldOffset: securityEntryOffset + 4,
    certificateTableOffset,
    certificateTableSize,
  };
}

function enrollmentEntryLength(trailerLength: number): { length: number; prefixPadding: number } | null {
  if (!Number.isSafeInteger(trailerLength) || trailerLength <= 0) return null;
  const prefixPadding = (8 - ((8 + trailerLength) % 8)) % 8;
  const length = 8 + prefixPadding + trailerLength;
  return length <= 0xffffffff ? { length, prefixPadding } : null;
}

export function buildWindowsAuthenticodeEnrollmentPlan(
  header: Buffer,
  artifactSize: number,
  trailer: Buffer,
): WindowsAuthenticodeEnrollmentPlan | null {
  const security = parseWindowsPeSecurityDirectory(header, artifactSize);
  const shape = enrollmentEntryLength(trailer.length);
  if (!security || !shape || security.certificateTableSize + shape.length > 0xffffffff) return null;
  const certificateEntry = Buffer.alloc(shape.length);
  certificateEntry.writeUInt32LE(shape.length, 0);
  certificateEntry.writeUInt16LE(WIN_CERT_REVISION_2_0, 4);
  certificateEntry.writeUInt16LE(IMCODES_ENROLLMENT_CERTIFICATE_TYPE, 6);
  trailer.copy(certificateEntry, 8 + shape.prefixPadding);
  const patchedCertificateTableSize = Buffer.alloc(4);
  patchedCertificateTableSize.writeUInt32LE(security.certificateTableSize + shape.length, 0);
  return {
    sizeFieldOffset: security.sizeFieldOffset,
    patchedCertificateTableSize,
    certificateEntry,
    trailerStart: artifactSize + 8 + shape.prefixPadding,
    personalizedSize: artifactSize + shape.length,
  };
}

export function inspectWindowsAuthenticodeEnrollmentContainer(
  header: Buffer,
  sourceSize: number,
  tail: Buffer,
  tailFileOffset: number,
  trailerStart: number,
  trailerLength: number,
): WindowsAuthenticodeEnrollmentRestore | null {
  const security = parseWindowsPeSecurityDirectory(header, sourceSize);
  const shape = enrollmentEntryLength(trailerLength);
  if (!security || !shape || security.certificateTableSize <= shape.length) return null;
  const entryStart = sourceSize - shape.length;
  const originalCertificateTableSize = security.certificateTableSize - shape.length;
  if (security.certificateTableOffset + originalCertificateTableSize !== entryStart
    || trailerStart !== entryStart + 8 + shape.prefixPadding
    || trailerStart + trailerLength !== sourceSize) return null;
  const tailEntryOffset = entryStart - tailFileOffset;
  if (tailEntryOffset < 0 || tailEntryOffset + shape.length > tail.length) return null;
  if (tail.readUInt32LE(tailEntryOffset) !== shape.length
    || tail.readUInt16LE(tailEntryOffset + 4) !== WIN_CERT_REVISION_2_0
    || tail.readUInt16LE(tailEntryOffset + 6) !== IMCODES_ENROLLMENT_CERTIFICATE_TYPE) return null;
  for (let i = 0; i < shape.prefixPadding; i += 1) {
    if (tail[tailEntryOffset + 8 + i] !== 0) return null;
  }
  return {
    signedArtifactSize: entryStart,
    sizeFieldOffset: security.sizeFieldOffset,
    originalCertificateTableSize,
    certificateEntryLength: shape.length,
  };
}
