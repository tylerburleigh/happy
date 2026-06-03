import { describe, expect, it } from 'vitest';
import { redactSpawnSessionOptionsForLog } from './spawnLogRedaction';

describe('daemon spawn log redaction', () => {
  it('removes token and environment variable values from spawn logs', () => {
    expect(redactSpawnSessionOptionsForLog({
      directory: '/workspace/project',
      agent: 'claude',
      token: 'oauth-secret',
      environmentVariables: {
        ANTHROPIC_AUTH_TOKEN: 'api-secret',
        SAFE_FLAG: 'enabled',
      },
    })).toEqual({
      directory: '/workspace/project',
      agent: 'claude',
      token: '[redacted]',
      environmentVariableKeys: ['ANTHROPIC_AUTH_TOKEN', 'SAFE_FLAG'],
    });
  });

  it('omits redacted fields when they were not provided', () => {
    expect(JSON.parse(JSON.stringify(redactSpawnSessionOptionsForLog({
      directory: '/workspace/project',
    })))).toEqual({
      directory: '/workspace/project',
    });
  });
});
