import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { SandboxConfigSchema } from '@/persistence';
import { buildSandboxedProcessEnv } from './env';
import { writePrivateFileSync } from '@/utils/privateFiles';

vi.mock('@/configuration', () => ({
    configuration: {
        happyHomeDir: '/tmp/happy-test-home',
        logsDir: '/tmp/happy-test-home/logs',
        isDaemonProcess: false,
    },
}));

vi.mock('@/utils/privateFiles', () => ({
    ensurePrivateDirSync: vi.fn(),
    writePrivateFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
    chmodSync: vi.fn(),
}));

describe('buildSandboxedProcessEnv', () => {
    it('keeps safe shell env and drops globally exported secrets', () => {
        const config = SandboxConfigSchema.parse({
            enabled: true,
            sessionIsolation: 'strict',
            customWritePaths: [],
            denyReadPaths: [],
            extraWritePaths: ['/tmp'],
            denyWritePaths: [],
            networkMode: 'blocked',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: false,
        });

        const env = buildSandboxedProcessEnv({
            PATH: '/usr/bin',
            HOME: '/Users/example',
            OPENAI_API_KEY: 'secret',
            CLAUDE_CODE_OAUTH_TOKEN: 'secret',
            HAPPY_SERVER_URL: 'https://happy.example',
        }, config, '/repo');

        expect(env.PATH).toContain('/tmp/happy-test-home/sandbox-bin');
        expect(env.HOME).toBe('/Users/example');
        expect(env.HAPPY_SERVER_URL).toBe('https://happy.example');
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
        expect(env.CODEX_HOME).toBe(`${homedir()}/.happy/agent-homes/codex`);
        expect(env.CLAUDE_CONFIG_DIR).toBe(`${homedir()}/.happy/agent-homes/claude`);
        expect(writePrivateFileSync).toHaveBeenCalledWith(
            '/tmp/happy-test-home/sandbox-bin/secret-tool',
            expect.stringContaining('Blocked by Happy sandbox guard'),
        );
        expect(writePrivateFileSync).toHaveBeenCalledWith(
            '/tmp/happy-test-home/sandbox-bin/wl-paste',
            expect.stringContaining('Blocked by Happy sandbox guard'),
        );
    });

    it('passes explicit env overrides even when they look sensitive', () => {
        const config = SandboxConfigSchema.parse({
            enabled: true,
            envPassthrough: [],
        });

        const env = buildSandboxedProcessEnv(
            { PATH: '/usr/bin', OPENAI_API_KEY: 'global-secret' },
            config,
            '/repo',
            { OPENAI_API_KEY: 'explicit-secret' },
        );

        expect(env.OPENAI_API_KEY).toBe('explicit-secret');
    });
});
