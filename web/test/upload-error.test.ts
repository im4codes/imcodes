import { describe, it, expect } from 'vitest';
import { isInsufficientCapacityError } from '../src/upload-error.js';

describe('isInsufficientCapacityError', () => {
  it('matches the shared code, 507 status, and raw ENOSPC text', () => {
    // The exact ApiError message the upload catch receives (status + parsed code).
    expect(isInsufficientCapacityError('API 507: insufficient_capacity')).toBe(true);
    // Raw JSON body fallback (server response body, no code parsed).
    expect(isInsufficientCapacityError('{"error":"insufficient_capacity","message":"ENOSPC: no space left on device"}')).toBe(true);
    // Bare daemon ENOSPC error text.
    expect(isInsufficientCapacityError('ENOSPC: no space left on device, write')).toBe(true);
    expect(isInsufficientCapacityError('no space left on device')).toBe(true);
    expect(isInsufficientCapacityError('API 507: unmapped')).toBe(true);
  });

  it('does not match unrelated file-transfer errors', () => {
    expect(isInsufficientCapacityError('API 503: daemon_offline')).toBe(false);
    expect(isInsufficientCapacityError('API 413: file_too_large')).toBe(false);
    expect(isInsufficientCapacityError('upload_failed')).toBe(false);
    expect(isInsufficientCapacityError('API 500: internal error')).toBe(false);
    expect(isInsufficientCapacityError('')).toBe(false);
  });
});
