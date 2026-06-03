import { afterEach, describe, expect, it, vi } from 'vitest';
import { HAPPY_DEFAULT_ENTRYPOINT } from './happyEntrypoint';

const mocks = vi.hoisted(() => ({
    mockSdkQuery: vi.fn(() => ({
        [Symbol.asyncIterator]: async function* () {},
    })),
    mockEnsureSandboxRuntimeDirsSync: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: mocks.mockSdkQuery,
    AbortError: class AbortError extends Error {},
}));

vi.mock('@/sandbox/temp', () => ({
    buildSandboxRuntimeEnv: (sessionPath: string) => ({
        HOME: `/sandbox-home/${sessionPath}`,
        TMPDIR: `/sandbox-temp/${sessionPath}`,
        TMP: `/sandbox-temp/${sessionPath}`,
        TEMP: `/sandbox-temp/${sessionPath}`,
    }),
    ensureSandboxRuntimeDirsSync: mocks.mockEnsureSandboxRuntimeDirsSync,
}));

import { query } from './query';

const originalEnv = {
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
};

function restoreEnvVar(key: keyof typeof originalEnv): void {
    const value = originalEnv[key];
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
}

describe('Claude SDK query env', () => {
    afterEach(() => {
        vi.clearAllMocks();
        restoreEnvVar('AWS_SECRET_ACCESS_KEY');
        restoreEnvVar('ANTHROPIC_AUTH_TOKEN');
    });

    it('filters ambient parent secrets when sandbox is enabled', () => {
        process.env.AWS_SECRET_ACCESS_KEY = 'ambient-aws-secret';
        process.env.ANTHROPIC_AUTH_TOKEN = 'ambient-anthropic-token';

        query({
            prompt: 'hello',
            options: {
                sandbox: { enabled: true } as any,
                env: {
                    ANTHROPIC_AUTH_TOKEN: 'explicit-anthropic-token',
                    HOME: '/home/unsafe',
                    TMPDIR: '/tmp/unsafe',
                },
            },
        });

        const sdkOptions = (mocks.mockSdkQuery.mock.calls as any)[0][0].options;
        expect(sdkOptions.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
        expect(sdkOptions.env.ANTHROPIC_AUTH_TOKEN).toBe('explicit-anthropic-token');
        expect(sdkOptions.env.CLAUDE_CODE_ENTRYPOINT).toBe(HAPPY_DEFAULT_ENTRYPOINT);
        expect(sdkOptions.env.HOME).toBe(`/sandbox-home/${process.cwd()}`);
        expect(sdkOptions.env.TMPDIR).toBe(`/sandbox-temp/${process.cwd()}`);
        expect(mocks.mockEnsureSandboxRuntimeDirsSync).toHaveBeenCalledWith(process.cwd());
    });

    it('preserves explicit Claude entrypoint env', () => {
        query({
            prompt: 'hello',
            options: {
                sandbox: { enabled: true } as any,
                env: {
                    CLAUDE_CODE_ENTRYPOINT: 'custom-entrypoint',
                },
            },
        });

        const sdkOptions = (mocks.mockSdkQuery.mock.calls as any)[0][0].options;
        expect(sdkOptions.env.CLAUDE_CODE_ENTRYPOINT).toBe('custom-entrypoint');
    });
});
