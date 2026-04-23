import { describe, expect, it } from 'vitest';
import { hasVersionJsonNoStoreCacheControl, parseVersionManifest } from './verify-build-artifacts.mjs';

describe('verify-build-artifacts helpers', () => {
  it('accepts /version.json blocks that include no-store alongside additional headers', () => {
    const headers = `/*
  Content-Security-Policy: default-src 'self'

/version.json
  Cache-Control: no-store, max-age=0
  X-Content-Type-Options: nosniff
`;

    expect(hasVersionJsonNoStoreCacheControl(headers)).toBe(true);
  });

  it('rejects /version.json blocks that omit no-store cache control', () => {
    const headers = `/*
  Content-Security-Policy: default-src 'self'

/version.json
  Cache-Control: public, max-age=60
`;

    expect(hasVersionJsonNoStoreCacheControl(headers)).toBe(false);
  });

  it('parses valid version manifests', () => {
    expect(parseVersionManifest('{"version":"v1.2.3","commitSha":"abcdef1"}')).toEqual({
      version: 'v1.2.3',
      commitSha: 'abcdef1'
    });
  });

  it('throws a targeted error for invalid version manifest JSON', () => {
    expect(() => parseVersionManifest('{bad json')).toThrow('dist/version.json must contain valid JSON.');
  });
});
