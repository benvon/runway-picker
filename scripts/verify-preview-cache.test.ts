import { describe, expect, it } from 'vitest';
import { parsePreviewRetryEnv } from './verify-preview-cache.mjs';

describe('parsePreviewRetryEnv', () => {
  it('uses defaults when env vars are unset', () => {
    expect(parsePreviewRetryEnv({})).toEqual({ maxAttempts: 6, delayMs: 5000 });
  });

  it('parses valid numeric strings', () => {
    expect(
      parsePreviewRetryEnv({
        PREVIEW_VERIFY_ATTEMPTS: '3',
        PREVIEW_VERIFY_DELAY_MS: '1000'
      })
    ).toEqual({ maxAttempts: 3, delayMs: 1000 });
  });

  it('falls back when values are non-numeric', () => {
    expect(
      parsePreviewRetryEnv({
        PREVIEW_VERIFY_ATTEMPTS: 'foo',
        PREVIEW_VERIFY_DELAY_MS: 'bar'
      })
    ).toEqual({ maxAttempts: 6, delayMs: 5000 });
  });

  it('clamps maxAttempts to at least 1', () => {
    expect(parsePreviewRetryEnv({ PREVIEW_VERIFY_ATTEMPTS: '0' })).toEqual({
      maxAttempts: 1,
      delayMs: 5000
    });
  });
});
