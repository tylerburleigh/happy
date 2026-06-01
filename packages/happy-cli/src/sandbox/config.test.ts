import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSandboxRuntimeConfig, getProtectedCommandPaths } from './config';
import { SandboxConfigSchema, type SandboxConfig } from '@/persistence';

const sessionPath = '/tmp/happy-session';

function resolveLikeRuntime(pathValue: string): string {
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    if (isAbsolute(expandedHome)) {
        return expandedHome;
    }
    return resolve(sessionPath, expandedHome);
}

function expectedSharedAgentStatePaths(config: SandboxConfig): string[] {
    const codexHome = config.agentHomeMode === 'shared'
        ? process.env.CODEX_HOME || '~/.codex'
        : config.isolatedCodexHome;
    const claudeConfigDir = config.agentHomeMode === 'shared'
        ? process.env.CLAUDE_CONFIG_DIR || '~/.claude'
        : config.isolatedClaudeConfigDir;
    return [...new Set([
        resolveLikeRuntime(codexHome),
        resolveLikeRuntime(claudeConfigDir),
    ])];
}

function expectedProtectedCommandPaths(): string[] {
    return getProtectedCommandPaths(process.platform);
}

function createConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return SandboxConfigSchema.parse({
        enabled: true,
        workspaceRoot: '~/projects',
        sessionIsolation: 'workspace',
        customWritePaths: [],
        denyReadPaths: ['~/.ssh', '~/.aws'],
        extraWritePaths: ['/tmp'],
        denyWritePaths: ['.env'],
        networkMode: 'allowed',
        allowedDomains: [],
        deniedDomains: [],
        allowLocalBinding: true,
        ...overrides,
    });
}

describe('buildSandboxRuntimeConfig', () => {
    it('uses platform-specific protected command deny paths', () => {
        expect(getProtectedCommandPaths('darwin')).toEqual(expect.arrayContaining([
            '/usr/bin/security',
            '/usr/bin/pbpaste',
            '/opt/homebrew/bin/gh',
            '/usr/local/bin/aws',
            '/usr/bin/ssh-add',
        ]));

        expect(getProtectedCommandPaths('linux')).toEqual(expect.arrayContaining([
            '/usr/bin/gh',
            '/usr/bin/secret-tool',
            '/usr/bin/pass',
            '/usr/bin/keyctl',
            '/usr/bin/wl-paste',
        ]));

        expect(getProtectedCommandPaths('win32')).toEqual([]);
    });

    it('builds strict filesystem isolation', () => {
        const config = createConfig({ sessionIsolation: 'strict' });
        const runtimeConfig = buildSandboxRuntimeConfig(
            config,
            sessionPath,
        );

        expect(runtimeConfig.allowPty).toBe(true);
        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            resolve(sessionPath),
            '/tmp',
            ...expectedSharedAgentStatePaths(config),
        ]);
    });

    it('builds workspace isolation using workspaceRoot fallback to sessionPath', () => {
        const config = createConfig();
        const withWorkspaceRoot = buildSandboxRuntimeConfig(config, sessionPath);
        expect(withWorkspaceRoot.filesystem?.allowWrite).toEqual([
            `${homedir()}/projects`,
            resolve(sessionPath),
            '/tmp',
            ...expectedSharedAgentStatePaths(config),
        ]);

        const withoutWorkspaceConfig = createConfig({ workspaceRoot: undefined });
        const withoutWorkspaceRoot = buildSandboxRuntimeConfig(
            withoutWorkspaceConfig,
            sessionPath,
        );
        expect(withoutWorkspaceRoot.filesystem?.allowWrite).toEqual([
            resolve(sessionPath),
            '/tmp',
            ...expectedSharedAgentStatePaths(withoutWorkspaceConfig),
        ]);
    });

    it('builds custom isolation from explicit custom paths', () => {
        const config = createConfig({
            sessionIsolation: 'custom',
            customWritePaths: ['~/sandbox', 'relative/write'],
            extraWritePaths: ['/tmp', '../scratch'],
        });
        const runtimeConfig = buildSandboxRuntimeConfig(
            config,
            sessionPath,
        );

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            `${homedir()}/sandbox`,
            resolve(sessionPath, 'relative/write'),
            '/tmp',
            resolve(sessionPath, '../scratch'),
            ...expectedSharedAgentStatePaths(config),
        ]);
    });

    it('maps blocked and allowed network modes', () => {
        const blocked = buildSandboxRuntimeConfig(
            createConfig({ networkMode: 'blocked', allowLocalBinding: false }),
            sessionPath,
        );
        expect(blocked.network?.allowedDomains).toEqual([]);
        expect(blocked.network?.deniedDomains).toEqual([]);
        expect(blocked.network?.allowLocalBinding).toBe(false);
        expect(blocked.enableWeakerNetworkIsolation).toBeUndefined();

        const allowed = buildSandboxRuntimeConfig(
            createConfig({ networkMode: 'allowed' }),
            sessionPath,
        );
        expect(allowed.network?.allowedDomains).toBeUndefined();
        expect(allowed.network?.deniedDomains).toEqual([]);
        expect(allowed.enableWeakerNetworkIsolation).toBe(true);
    });

    it('maps custom network mode from user lists', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                networkMode: 'custom',
                allowedDomains: ['*.github.com', 'api.openai.com'],
                deniedDomains: ['tracking.example.com'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.network?.allowedDomains).toEqual(['*.github.com', 'api.openai.com']);
        expect(runtimeConfig.network?.deniedDomains).toEqual(['tracking.example.com']);
    });

    it('resolves tilde and relative paths across all filesystem path fields', () => {
        const config = createConfig({
            sessionIsolation: 'custom',
            customWritePaths: ['~/custom', 'relative/custom'],
            extraWritePaths: ['~/extra', './extra'],
            denyReadPaths: ['~/.ssh', 'relative/read'],
            denyWritePaths: ['.env', 'relative/write-deny'],
        });
        const runtimeConfig = buildSandboxRuntimeConfig(
            config,
            sessionPath,
        );

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            `${homedir()}/custom`,
            resolve(sessionPath, 'relative/custom'),
            `${homedir()}/extra`,
            resolve(sessionPath, './extra'),
            ...expectedSharedAgentStatePaths(config),
        ]);
        expect(runtimeConfig.filesystem?.denyRead).toEqual([
            `${homedir()}/.ssh`,
            resolve(sessionPath, 'relative/read'),
            ...expectedProtectedCommandPaths(),
        ]);
        expect(runtimeConfig.filesystem?.denyWrite).toEqual([
            resolve(sessionPath, '.env'),
            resolve(sessionPath, 'relative/write-deny'),
        ]);
    });

    it('includes overridden CODEX_HOME and CLAUDE_CONFIG_DIR in allowWrite when shared agent homes are enabled', () => {
        const originalCodexHome = process.env.CODEX_HOME;
        const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

        try {
            process.env.CODEX_HOME = '~/custom-codex-home';
            process.env.CLAUDE_CONFIG_DIR = './custom-claude-config';

            const runtimeConfig = buildSandboxRuntimeConfig(createConfig({ agentHomeMode: 'shared' }), sessionPath);

            expect(runtimeConfig.filesystem?.allowWrite).toContain(`${homedir()}/custom-codex-home`);
            expect(runtimeConfig.filesystem?.allowWrite).toContain(resolve(sessionPath, './custom-claude-config'));
        } finally {
            if (originalCodexHome === undefined) {
                delete process.env.CODEX_HOME;
            } else {
                process.env.CODEX_HOME = originalCodexHome;
            }

            if (originalClaudeConfigDir === undefined) {
                delete process.env.CLAUDE_CONFIG_DIR;
            } else {
                process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
            }
        }
    });
});
