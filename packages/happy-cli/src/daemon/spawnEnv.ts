export type SpawnEnvironmentValidationIssue = {
  key?: string;
  message: string;
};

export const MAX_SPAWN_ENV_KEY_LENGTH = 128;
export const MAX_SPAWN_ENV_VALUE_LENGTH = 32768;
export const MAX_SPAWN_ENV_VARIABLES = 128;

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const BLOCKED_CALLER_SPAWN_ENV_KEYS = new Set([
  'BASH_ENV',
  'BUN_OPTIONS',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'ENV',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'PATHEXT',
  'SHELL',
  'TMP',
  'TMPDIR',
  'TEMP',
  'USERPROFILE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'ZDOTDIR',
]);

export function isBlockedSpawnEnvKey(key: string): boolean {
  return BLOCKED_CALLER_SPAWN_ENV_KEYS.has(key)
    || key.startsWith('DYLD_')
    || key.startsWith('HAPPY_')
    || key.startsWith('LD_');
}

function validateSpawnEnvironmentEntries(
  entries: [string, unknown][],
  options: { enforceBlockedKeys: boolean },
): SpawnEnvironmentValidationIssue[] {
  const issues: SpawnEnvironmentValidationIssue[] = [];

  if (entries.length > MAX_SPAWN_ENV_VARIABLES) {
    issues.push({ message: `must contain at most ${MAX_SPAWN_ENV_VARIABLES} entries` });
  }

  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_SPAWN_ENV_KEY_LENGTH || !ENV_KEY_PATTERN.test(key)) {
      issues.push({ key, message: 'environment variable key is invalid' });
    }

    if (options.enforceBlockedKeys && isBlockedSpawnEnvKey(key)) {
      issues.push({ key, message: 'environment variable key is not allowed for daemon-spawned sessions' });
    }

    if (
      typeof value !== 'string'
      || value.length > MAX_SPAWN_ENV_VALUE_LENGTH
      || /[\u0000-\u001f\u007f]/.test(value)
    ) {
      issues.push({ key, message: 'environment variable value is invalid' });
    }
  }

  return issues;
}

export function validateCallerSpawnEnvironmentVariables(env: unknown): SpawnEnvironmentValidationIssue[] {
  if (env === undefined) {
    return [];
  }

  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return [{ message: 'environmentVariables must be an object' }];
  }

  return validateSpawnEnvironmentEntries(Object.entries(env), { enforceBlockedKeys: true });
}

export function validateSpawnEnvironmentValues(env: Record<string, string>): SpawnEnvironmentValidationIssue[] {
  return validateSpawnEnvironmentEntries(Object.entries(env), { enforceBlockedKeys: false });
}

export function formatSpawnEnvironmentValidationIssues(issues: SpawnEnvironmentValidationIssue[]): string {
  return issues.map((issue) =>
    issue.key ? `${issue.key}: ${issue.message}` : issue.message,
  ).join('; ');
}
