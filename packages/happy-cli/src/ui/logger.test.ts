import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from './logger';

const { mockAppendFileSync, mockChmodSync } = vi.hoisted(() => ({
  mockAppendFileSync: vi.fn(),
  mockChmodSync: vi.fn(),
}));

vi.mock('fs', () => ({
  appendFileSync: mockAppendFileSync,
  chmodSync: mockChmodSync,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    logsDir: '/tmp/happy-test-home/logs',
    isDaemonProcess: false,
  },
}));

vi.mock('@/utils/privateFiles', () => ({
  PRIVATE_FILE_MODE: 0o600,
}));

describe('Logger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redacts secrets before writing file logs', () => {
    const logger = new Logger('/tmp/happy-test.log');

    logger.debug(
      'payload',
      { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz123456', tokenDataType: 'object' },
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456',
    );

    const written = String(mockAppendFileSync.mock.calls.at(-1)?.[1]);

    expect(written).toContain("apiKey: '[REDACTED]'");
    expect(written).toContain("tokenDataType: 'object'");
    expect(written).toContain('Authorization: Bearer [REDACTED]');
    expect(written).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(written).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });
});
