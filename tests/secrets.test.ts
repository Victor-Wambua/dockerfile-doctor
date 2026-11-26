import { describe, expect, it } from 'vitest';
import {
  findSecretPatterns,
  isNonLiteral,
  isSecretName,
  looksHighEntropy,
  shannonEntropy,
} from '../src/core/secrets.js';

describe('isSecretName', () => {
  it.each([
    'DB_PASSWORD',
    'api_key',
    'GITHUB_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'MPESA_CONSUMER_KEY',
    'STRIPE_SECRET',
    'DB_PASS',
    'JWT_SIGNING_KEY',
  ])('treats %s as secret-like', (n) => expect(isSecretName(n)).toBe(true));

  it.each([
    'PATH',
    'PWD',
    'APP_ENV',
    'PASSWORD_MIN_LENGTH',
    'TOKEN_FILE',
    'SECRET_KEY_PATH',
    'TOKEN_URL',
    'PORT',
    'NODE_ENV',
    'AUTHOR',
  ])('does not flag %s', (n) => expect(isSecretName(n)).toBe(false));
});

describe('isNonLiteral', () => {
  it.each([
    undefined,
    '',
    '  ',
    '$TOKEN',
    '${TOKEN}',
    '${TOKEN:-}',
    '<your-token>',
    'xxxx',
    '***',
    '/run/secrets/token',
  ])('accepts %j as a non-secret value', (v) => expect(isNonLiteral(v)).toBe(true));
  it.each(['hunter2', 'changeme', 'abc123def'])('treats %s as a literal', (v) =>
    expect(isNonLiteral(v)).toBe(false),
  );
});

describe('findSecretPatterns', () => {
  it.each([
    ['AKIAIOSFODNN7EXAMPLE', 'AWS access key id'],
    ['ghp_0123456789abcdefghijklmnopqrstuvwxyz', 'GitHub token'],
    ['xoxb-1234567890-abcdefghij', 'Slack token'],
    ['sk_live_abcdefghijklmnopqrstuv', 'Stripe secret key'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----', 'private key block'],
    ['postgres://admin:s3cret@db.internal/app', 'credentials embedded in a URL'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop', 'JSON web token'],
  ])('detects %s', (text, kind) => {
    expect(findSecretPatterns(`value ${text} end`).map((h) => h.kind)).toContain(kind);
  });

  it('ignores URLs without credentials or with variable passwords', () => {
    expect(findSecretPatterns('https://example.com/path')).toEqual([]);
    expect(findSecretPatterns('https://user:${PASS}@example.com/')).toEqual([]);
    expect(findSecretPatterns('git@github.com:org/repo.git')).toEqual([]);
  });
});

describe('entropy', () => {
  it('computes Shannon entropy', () => {
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
  });

  it('flags long random-looking tokens', () => {
    expect(looksHighEntropy('Zk9xQ2LmP8vTnR4sYb7WdEu3HcJ6AfGa')).toBe(true);
  });

  it('does not flag checksums, versions, words or short values', () => {
    expect(
      looksHighEntropy('3b8b1d7ac1c0e2f0a64d5a5de0b6f8e0b6a0a4f3a2c5e5c3d2a1b0f9e8d7c6b5'),
    ).toBe(false); // sha256 hex
    expect(looksHighEntropy('1.2.3')).toBe(false);
    expect(looksHighEntropy('production-readonly-service-account')).toBe(false);
    expect(looksHighEntropy('Zk9xQ2Lm')).toBe(false);
  });
});
