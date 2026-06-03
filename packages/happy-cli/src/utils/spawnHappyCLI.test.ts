import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockProjectPath: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock('cross-spawn', () => ({
  spawn: mocks.mockSpawn,
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.mockExistsSync,
}));

vi.mock('@/projectPath', () => ({
  projectPath: mocks.mockProjectPath,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

import { spawnHappyCLI } from './spawnHappyCLI';

describe('spawnHappyCLI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockExistsSync.mockReturnValue(true);
    mocks.mockProjectPath.mockReturnValue('/repo');
  });

  it('uses the current executable instead of resolving the runtime through PATH', () => {
    const childProcess = { pid: 123 };
    const env = { PATH: '/tmp/malicious-bin' };
    mocks.mockSpawn.mockReturnValue(childProcess);

    const result = spawnHappyCLI(['daemon', 'start'], { env });

    expect(result).toBe(childProcess);
    expect(mocks.mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [
        '--no-warnings',
        '--no-deprecation',
        join('/repo', 'dist', 'index.mjs'),
        'daemon',
        'start',
      ],
      expect.objectContaining({
        windowsHide: true,
        env,
      }),
    );
  });
});
