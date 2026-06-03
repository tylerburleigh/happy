import { describe, expect, it } from 'vitest';
import {
  formatSpawnSessionValidationIssues,
  validateSpawnSessionOptions,
} from './spawnValidation';

describe('daemon spawn request validation', () => {
  it('accepts valid spawn options', () => {
    expect(validateSpawnSessionOptions({
      directory: '/workspace/project',
      sessionId: 'session-1',
      machineId: 'machine-1',
      approvedNewDirectoryCreation: false,
      resumeClaudeSessionId: '550e8400-e29b-41d4-a716-446655440000',
      parentSessionId: 'parent-session',
      forkedFromMessageId: 'message-1',
      token: 'token',
    })).toEqual([]);
  });

  it('rejects invalid directory values', () => {
    expect(validateSpawnSessionOptions({
      directory: ' /workspace/project',
    })).toEqual([
      { field: 'directory', message: 'must not be empty or whitespace-padded' },
    ]);

    expect(validateSpawnSessionOptions({
      directory: '/workspace/project\nnext',
    })).toEqual([
      { field: 'directory', message: 'must not contain control characters' },
    ]);
  });

  it('rejects flag-shaped resume ids before building argv', () => {
    expect(validateSpawnSessionOptions({
      directory: '/workspace/project',
      resumeClaudeSessionId: '--dangerous-flag',
    })).toEqual([
      { field: 'resumeClaudeSessionId', message: 'must not look like a CLI flag' },
    ]);
  });

  it('rejects non-boolean directory creation approval', () => {
    expect(validateSpawnSessionOptions({
      directory: '/workspace/project',
      approvedNewDirectoryCreation: 'false',
    })).toEqual([
      { field: 'approvedNewDirectoryCreation', message: 'must be a boolean' },
    ]);
  });

  it('formats validation issues for daemon error messages', () => {
    expect(formatSpawnSessionValidationIssues([
      { field: 'directory', message: 'is required' },
      { field: 'resumeClaudeSessionId', message: 'must not look like a CLI flag' },
    ])).toBe('directory: is required; resumeClaudeSessionId: must not look like a CLI flag');
  });
});
