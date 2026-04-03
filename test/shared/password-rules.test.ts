import { describe, it, expect } from 'vitest';
import { validatePasswordComplexity, USERNAME_REGEX } from '../../shared/password-rules.js';

describe('validatePasswordComplexity', () => {
  it('rejects passwords shorter than 8 characters', () => {
    expect(validatePasswordComplexity('Abc1').valid).toBe(false);
    expect(validatePasswordComplexity('Abc1').errorKey).toBe('password_too_short');
  });

  it('rejects passwords without uppercase', () => {
    expect(validatePasswordComplexity('abcdefg1').valid).toBe(false);
    expect(validatePasswordComplexity('abcdefg1').errorKey).toBe('password_missing_uppercase');
  });

  it('rejects passwords without lowercase', () => {
    expect(validatePasswordComplexity('ABCDEFG1').valid).toBe(false);
    expect(validatePasswordComplexity('ABCDEFG1').errorKey).toBe('password_missing_lowercase');
  });

  it('rejects passwords without digits', () => {
    expect(validatePasswordComplexity('Abcdefgh').valid).toBe(false);
    expect(validatePasswordComplexity('Abcdefgh').errorKey).toBe('password_missing_digit');
  });

  it('accepts valid passwords', () => {
    expect(validatePasswordComplexity('Abcdefg1').valid).toBe(true);
    expect(validatePasswordComplexity('Abcdefg1').errorKey).toBeNull();
  });

  it('accepts passwords with special characters', () => {
    expect(validatePasswordComplexity('Abcdefg1!@#').valid).toBe(true);
  });
});

describe('USERNAME_REGEX', () => {
  it('accepts valid usernames', () => {
    expect(USERNAME_REGEX.test('alice')).toBe(true);
    expect(USERNAME_REGEX.test('bob123')).toBe(true);
    expect(USERNAME_REGEX.test('alice.bob')).toBe(true);
    expect(USERNAME_REGEX.test('a-b')).toBe(true);
    expect(USERNAME_REGEX.test('a_b')).toBe(true);
  });

  it('rejects invalid usernames', () => {
    expect(USERNAME_REGEX.test('ab')).toBe(false); // too short
    expect(USERNAME_REGEX.test('.abc')).toBe(false); // starts with dot
    expect(USERNAME_REGEX.test('abc.')).toBe(false); // ends with dot
    expect(USERNAME_REGEX.test('ABC')).toBe(false); // uppercase not allowed
  });
});
