import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

const REDACTED = '[redacted]';

export function redactSpawnSessionOptionsForLog(options: SpawnSessionOptions): Record<string, unknown> {
  const {
    environmentVariables,
    token,
    ...safeOptions
  } = options;

  return {
    ...safeOptions,
    token: token ? REDACTED : undefined,
    environmentVariableKeys: environmentVariables
      ? Object.keys(environmentVariables).sort()
      : undefined,
  };
}
