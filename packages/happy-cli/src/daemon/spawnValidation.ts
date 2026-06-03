import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

export type SpawnSessionValidationIssue = {
  field?: string;
  message: string;
};

const MAX_SPAWN_PATH_LENGTH = 4096;
const MAX_SPAWN_ID_LENGTH = 256;
const MAX_SPAWN_TOKEN_LENGTH = 131072;

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function validateStringField(
  issues: SpawnSessionValidationIssue[],
  value: unknown,
  field: string,
  options: { required: boolean; maxLength: number; rejectFlagShaped?: boolean },
): void {
  if (value === undefined) {
    if (options.required) {
      issues.push({ field, message: 'is required' });
    }
    return;
  }

  if (typeof value !== 'string') {
    issues.push({ field, message: 'must be a string' });
    return;
  }

  if (value.trim().length === 0 || value !== value.trim()) {
    issues.push({ field, message: 'must not be empty or whitespace-padded' });
  }

  if (value.length > options.maxLength) {
    issues.push({ field, message: 'exceeds maximum length' });
  }

  if (hasControlCharacters(value)) {
    issues.push({ field, message: 'must not contain control characters' });
  }

  if (options.rejectFlagShaped && value.startsWith('-')) {
    issues.push({ field, message: 'must not look like a CLI flag' });
  }
}

export function validateSpawnSessionOptions(options: unknown): SpawnSessionValidationIssue[] {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    return [{ message: 'spawn options must be an object' }];
  }

  const spawnOptions = options as Partial<SpawnSessionOptions>;
  const issues: SpawnSessionValidationIssue[] = [];

  validateStringField(issues, spawnOptions.directory, 'directory', {
    required: true,
    maxLength: MAX_SPAWN_PATH_LENGTH,
  });
  validateStringField(issues, spawnOptions.sessionId, 'sessionId', {
    required: false,
    maxLength: MAX_SPAWN_ID_LENGTH,
  });
  validateStringField(issues, spawnOptions.machineId, 'machineId', {
    required: false,
    maxLength: MAX_SPAWN_ID_LENGTH,
  });
  validateStringField(issues, spawnOptions.resumeClaudeSessionId, 'resumeClaudeSessionId', {
    required: false,
    maxLength: MAX_SPAWN_ID_LENGTH,
    rejectFlagShaped: true,
  });
  validateStringField(issues, spawnOptions.parentSessionId, 'parentSessionId', {
    required: false,
    maxLength: MAX_SPAWN_ID_LENGTH,
  });
  validateStringField(issues, spawnOptions.forkedFromMessageId, 'forkedFromMessageId', {
    required: false,
    maxLength: MAX_SPAWN_ID_LENGTH,
  });
  validateStringField(issues, spawnOptions.token, 'token', {
    required: false,
    maxLength: MAX_SPAWN_TOKEN_LENGTH,
  });

  if (
    spawnOptions.approvedNewDirectoryCreation !== undefined
    && typeof spawnOptions.approvedNewDirectoryCreation !== 'boolean'
  ) {
    issues.push({ field: 'approvedNewDirectoryCreation', message: 'must be a boolean' });
  }

  return issues;
}

export function formatSpawnSessionValidationIssues(issues: SpawnSessionValidationIssue[]): string {
  return issues.map((issue) =>
    issue.field ? `${issue.field}: ${issue.message}` : issue.message,
  ).join('; ');
}
