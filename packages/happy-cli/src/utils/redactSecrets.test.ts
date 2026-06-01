import { describe, expect, it } from 'vitest';
import { isSecretLikeKey, redactSecrets, redactSensitiveData } from './redactSecrets';

describe('redactSecrets', () => {
  it('redacts common env assignment and JSON-style secret values', () => {
    const input = [
      'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
      '"accessToken": "ya29.abcdefghijklmnopqrstuvwxyz123456"',
      "clientSecret: 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890'",
    ].join('\n');

    const redacted = redactSecrets(input);

    expect(redacted).toContain('OPENAI_API_KEY=[REDACTED]');
    expect(redacted).toContain('"accessToken": "[REDACTED]"');
    expect(redacted).toContain("clientSecret: '[REDACTED]'");
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(redacted).not.toContain('github_pat_abcdefghijklmnopqrstuvwxyz1234567890');
  });

  it('redacts bearer tokens and private key blocks', () => {
    const redacted = redactSecrets([
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
      '-----BEGIN PRIVATE KEY-----',
      'not actually a key, but should not be logged',
      '-----END PRIVATE KEY-----',
    ].join('\n'));

    expect(redacted).toContain('Authorization: Bearer [REDACTED]');
    expect(redacted).toContain('-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----');
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(redacted).not.toContain('not actually a key');
  });

  it('does not redact ordinary token metadata labels', () => {
    const redacted = redactSecrets('tokenDataType: "object", tokenCount: 42, token: "secret-value"');

    expect(redacted).toContain('tokenDataType: "object"');
    expect(redacted).toContain('tokenCount: 42');
    expect(redacted).toContain('token: "[REDACTED]"');
  });
});

describe('isSecretLikeKey', () => {
  it('classifies secret-looking keys without flagging public keys', () => {
    expect(isSecretLikeKey('CLAUDE_CODE_OAUTH_TOKEN')).toBe(true);
    expect(isSecretLikeKey('apiKey')).toBe(true);
    expect(isSecretLikeKey('publicKey')).toBe(false);
    expect(isSecretLikeKey('tokenCount')).toBe(false);
  });
});

describe('redactSensitiveData', () => {
  it('redacts string content and sensitive object fields recursively', () => {
    const redacted = redactSensitiveData({
      summary: { text: 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456' },
      nested: { accessToken: 'plain-token-value' },
      publicKey: 'safe-to-display',
    });

    expect(redacted.summary.text).toBe('OPENAI_API_KEY=[REDACTED]');
    expect(redacted.nested.accessToken).toBe('[REDACTED]');
    expect(redacted.publicKey).toBe('safe-to-display');
  });
});
