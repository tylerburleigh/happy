import { describe, expect, it } from 'vitest';
import {
  formatSpawnEnvironmentValidationIssues,
  validateCallerSpawnEnvironmentVariables,
  validateSpawnEnvironmentValues,
} from './spawnEnv';

describe('daemon spawn environment validation', () => {
  it('accepts ordinary caller-supplied environment variables', () => {
    expect(validateCallerSpawnEnvironmentVariables({
      ANTHROPIC_AUTH_TOKEN: 'token',
      CUSTOM_FLAG: 'enabled',
      TMUX_SESSION_NAME: '',
    })).toEqual([]);
  });

  it('rejects non-object caller environment payloads', () => {
    expect(validateCallerSpawnEnvironmentVariables(['BAD=value'])).toEqual([
      { message: 'environmentVariables must be an object' },
    ]);
  });

  it('rejects malformed caller environment keys', () => {
    expect(validateCallerSpawnEnvironmentVariables({
      'BAD-KEY': 'value',
      '': 'empty',
    })).toEqual([
      { key: 'BAD-KEY', message: 'environment variable key is invalid' },
      { key: '', message: 'environment variable key is invalid' },
    ]);
  });

  it('rejects caller environment keys that can change daemon launch behavior', () => {
    const issues = validateCallerSpawnEnvironmentVariables({
      PATH: '/tmp/bin',
      HAPPY_HOME_DIR: '/tmp/happy',
      NODE_OPTIONS: '--require /tmp/hook.js',
      DYLD_INSERT_LIBRARIES: '/tmp/hook.dylib',
      LD_PRELOAD: '/tmp/hook.so',
    });

    expect(issues).toEqual([
      { key: 'PATH', message: 'environment variable key is not allowed for daemon-spawned sessions' },
      { key: 'HAPPY_HOME_DIR', message: 'environment variable key is not allowed for daemon-spawned sessions' },
      { key: 'NODE_OPTIONS', message: 'environment variable key is not allowed for daemon-spawned sessions' },
      { key: 'DYLD_INSERT_LIBRARIES', message: 'environment variable key is not allowed for daemon-spawned sessions' },
      { key: 'LD_PRELOAD', message: 'environment variable key is not allowed for daemon-spawned sessions' },
    ]);
  });

  it('rejects caller environment values with control characters', () => {
    expect(validateCallerSpawnEnvironmentVariables({
      SAFE_KEY: 'bad\nvalue',
    })).toEqual([
      { key: 'SAFE_KEY', message: 'environment variable value is invalid' },
    ]);
  });

  it('allows internal daemon keys while validating post-expansion values', () => {
    expect(validateSpawnEnvironmentValues({
      HAPPY_FORKED_FROM_SESSION_ID: 'session-1',
      CODEX_HOME: '/tmp/codex-home',
    })).toEqual([]);

    expect(validateSpawnEnvironmentValues({
      HAPPY_FORKED_FROM_SESSION_ID: 'bad\nsession',
    })).toEqual([
      { key: 'HAPPY_FORKED_FROM_SESSION_ID', message: 'environment variable value is invalid' },
    ]);
  });

  it('formats validation issues for daemon error messages', () => {
    expect(formatSpawnEnvironmentValidationIssues([
      { key: 'PATH', message: 'environment variable key is not allowed for daemon-spawned sessions' },
      { message: 'must contain at most 128 entries' },
    ])).toBe('PATH: environment variable key is not allowed for daemon-spawned sessions; must contain at most 128 entries');
  });
});
