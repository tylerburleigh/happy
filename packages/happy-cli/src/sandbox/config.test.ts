import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSandboxRuntimeConfig, getProtectedCommandPaths } from './config';
import { SandboxConfigSchema, type SandboxConfig } from '@/persistence';
import { getSandboxHomeDir, getSandboxTempDir } from './temp';
import { configuration } from '@/configuration';

const sessionPath = '/tmp/happy-session';

function resolveLikeRuntime(pathValue: string): string {
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    if (isAbsolute(expandedHome)) {
        return expandedHome;
    }
    return resolve(sessionPath, expandedHome);
}

function expectedSharedAgentStatePaths(): string[] {
    const codexHome = process.env.CODEX_HOME || '~/.codex';
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || '~/.claude';
    return [...new Set([
        resolveLikeRuntime(codexHome),
        resolveLikeRuntime(claudeConfigDir),
    ])];
}

function expectedPathVariants(pathValue: string): string[] {
    const variants = [pathValue];
    try {
        const realPath = realpathSync(pathValue);
        if (!variants.includes(realPath)) {
            variants.push(realPath);
        }
    } catch {
        // Missing paths are still represented by their configured spelling.
    }
    return variants;
}

function expectedHappyStateDenyPaths(): string[] {
    const happyHomeDir = resolve(configuration.happyHomeDir);
    return [
        join(happyHomeDir, 'access.key'),
        join(happyHomeDir, 'daemon.state.json'),
        join(happyHomeDir, 'logs'),
        join(happyHomeDir, 'server-data'),
        join(happyHomeDir, 'sessions.json'),
        join(happyHomeDir, 'settings.json'),
    ].flatMap(expectedPathVariants);
}

function expectedProtectedCommandPaths(): string[] {
    return getProtectedCommandPaths(process.platform).flatMap(expectedPathVariants);
}

function createConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return SandboxConfigSchema.parse({
        enabled: true,
        workspaceRoot: '~/projects',
        sessionIsolation: 'workspace',
        customWritePaths: [],
        denyReadPaths: ['~/.ssh', '~/.aws'],
        extraWritePaths: [],
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
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({ sessionIsolation: 'strict' }),
            sessionPath,
        );

        expect(runtimeConfig.allowPty).toBe(true);
        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            resolve(sessionPath),
            getSandboxHomeDir(sessionPath),
            getSandboxTempDir(sessionPath),
        ]);
    });

    it('builds workspace isolation using workspaceRoot fallback to sessionPath', () => {
        const withWorkspaceRoot = buildSandboxRuntimeConfig(createConfig(), sessionPath);
        expect(withWorkspaceRoot.filesystem?.allowWrite).toEqual([
            `${homedir()}/projects`,
            resolve(sessionPath),
            getSandboxHomeDir(sessionPath),
            getSandboxTempDir(sessionPath),
        ]);

        const withoutWorkspaceRoot = buildSandboxRuntimeConfig(
            createConfig({ workspaceRoot: undefined }),
            sessionPath,
        );
        expect(withoutWorkspaceRoot.filesystem?.allowWrite).toEqual([
            resolve(sessionPath),
            getSandboxHomeDir(sessionPath),
            getSandboxTempDir(sessionPath),
        ]);
    });

    it('builds custom isolation from explicit custom paths', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                sessionIsolation: 'custom',
                customWritePaths: ['~/sandbox', 'relative/write'],
                extraWritePaths: ['scratch'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            `${homedir()}/sandbox`,
            resolve(sessionPath, 'relative/write'),
            getSandboxHomeDir(sessionPath),
            getSandboxTempDir(sessionPath),
            resolve(sessionPath, 'scratch'),
        ]);
    });

    it('maps blocked and allowed network modes', () => {
        const blocked = buildSandboxRuntimeConfig(
            createConfig({ networkMode: 'blocked', allowLocalBinding: true }),
            sessionPath,
        );
        expect(blocked.network?.allowedDomains).toEqual([]);
        expect(blocked.network?.deniedDomains).toEqual([]);
        expect(blocked.network?.allowLocalBinding).toBe(false);
        expect(blocked.enableWeakerNetworkIsolation).toBeUndefined();

        const allowed = buildSandboxRuntimeConfig(
            createConfig({ networkMode: 'allowed', deniedDomains: ['Tracking.Example.com', 'tracking.example.com'] }),
            sessionPath,
        );
        expect(allowed.network?.allowedDomains).toBeUndefined();
        expect(allowed.network?.deniedDomains).toEqual(['tracking.example.com']);
        expect(allowed.enableWeakerNetworkIsolation).toBe(true);
    });

    it('maps custom network mode from user lists', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                networkMode: 'custom',
                allowedDomains: ['*.GitHub.com', 'API.OpenAI.com', 'api.openai.com', 'localhost'],
                deniedDomains: ['Tracking.Example.com'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.network?.allowedDomains).toEqual(['*.github.com', 'api.openai.com', 'localhost']);
        expect(runtimeConfig.network?.deniedDomains).toEqual(['tracking.example.com']);
    });

    it('resolves tilde and relative paths across all filesystem path fields', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                sessionIsolation: 'custom',
                customWritePaths: ['~/custom', 'relative/custom'],
                extraWritePaths: ['~/extra', './extra'],
                denyReadPaths: ['~/.ssh', 'relative/read'],
                denyWritePaths: ['.env', 'relative/write-deny'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            `${homedir()}/custom`,
            resolve(sessionPath, 'relative/custom'),
            getSandboxHomeDir(sessionPath),
            getSandboxTempDir(sessionPath),
            `${homedir()}/extra`,
            resolve(sessionPath, './extra'),
        ]);
        expect(runtimeConfig.filesystem?.denyRead).toEqual([
            `${homedir()}/.ssh`,
            resolve(sessionPath, 'relative/read'),
            ...expectedProtectedCommandPaths(),
            ...expectedHappyStateDenyPaths(),
        ]);
        expect(runtimeConfig.filesystem?.denyWrite).toEqual([
            resolve(sessionPath, '.env'),
            resolve(sessionPath, 'relative/write-deny'),
            `${homedir()}/.ssh`,
            resolve(sessionPath, 'relative/read'),
            ...expectedProtectedCommandPaths(),
            ...expectedHappyStateDenyPaths(),
        ]);
    });

    it('only includes shared provider state paths when explicitly requested', () => {
        const originalCodexHome = process.env.CODEX_HOME;
        const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

        try {
            process.env.CODEX_HOME = '~/custom-codex-home';
            process.env.CLAUDE_CONFIG_DIR = './custom-claude-config';

            const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), sessionPath);
            expect(runtimeConfig.filesystem?.allowWrite).not.toContain(`${homedir()}/custom-codex-home`);
            expect(runtimeConfig.filesystem?.allowWrite).not.toContain(resolve(sessionPath, './custom-claude-config'));

            const withSharedState = buildSandboxRuntimeConfig(createConfig(), sessionPath, {
                includeSharedAgentStatePaths: true,
            });

            expect(withSharedState.filesystem?.allowWrite).toEqual(
                expect.arrayContaining(expectedSharedAgentStatePaths()),
            );
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

    it('can replace shared agent state paths with isolated state paths', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), sessionPath, {
            includeSharedAgentStatePaths: false,
            agentStatePaths: ['/tmp/happy-sandbox-state/claude'],
            denyReadPaths: ['~/.claude'],
        });

        expect(runtimeConfig.filesystem?.allowWrite).toEqual([
            `${homedir()}/projects`,
            resolve(sessionPath),
            getSandboxHomeDir(sessionPath),
            getSandboxTempDir(sessionPath),
            '/tmp/happy-sandbox-state/claude',
        ]);
        expect(runtimeConfig.filesystem?.denyRead).toEqual([
            `${homedir()}/.ssh`,
            `${homedir()}/.aws`,
            `${homedir()}/.claude`,
            ...expectedProtectedCommandPaths(),
            ...expectedHappyStateDenyPaths(),
        ]);
    });

    it('anchors simple relative deny paths to the workspace root as well as the session path', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                workspaceRoot: '~/projects',
                denyReadPaths: ['.env', 'secrets', '../parent-secret'],
                denyWritePaths: ['.npmrc'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.filesystem?.denyRead).toEqual(
            expect.arrayContaining([
                resolve(sessionPath, '.env'),
                `${homedir()}/projects/.env`,
                resolve(sessionPath, 'secrets'),
                `${homedir()}/projects/secrets`,
                resolve(sessionPath, '../parent-secret'),
            ]),
        );
        expect(runtimeConfig.filesystem?.denyRead).not.toContain(`${homedir()}/parent-secret`);
        expect(runtimeConfig.filesystem?.denyWrite).toEqual(
            expect.arrayContaining([
                resolve(sessionPath, '.npmrc'),
                `${homedir()}/projects/.npmrc`,
                resolve(sessionPath, '.env'),
                `${homedir()}/projects/.env`,
            ]),
        );
    });

    it('rejects dangerously broad allow-write workspace roots', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    workspaceRoot: '~',
                }),
                sessionPath,
            ),
        ).toThrow(/allow-write path is too broad/);
    });

    it('rejects dangerously broad custom allow-write paths', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    sessionIsolation: 'custom',
                    customWritePaths: ['/'],
                }),
                sessionPath,
            ),
        ).toThrow(/allow-write path is too broad/);
    });

    it('rejects shared temp roots as session allow-write paths', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    sessionIsolation: 'strict',
                }),
                '/private/tmp',
            ),
        ).toThrow(/allow-write path is too broad/);
    });

    it('rejects exact allow-write and denied path conflicts', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    sessionIsolation: 'custom',
                    customWritePaths: ['~/secret'],
                    denyReadPaths: ['~/secret'],
                    denyWritePaths: [],
                }),
                sessionPath,
            ),
        ).toThrow(/allow-write path conflicts with denied path/);
    });

    it('rejects allow-write paths inside denied directories', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    sessionIsolation: 'custom',
                    customWritePaths: ['~/secret/cache'],
                    denyReadPaths: ['~/secret'],
                    denyWritePaths: [],
                }),
                sessionPath,
            ),
        ).toThrow(/allow-write path conflicts with denied path/);
    });

    it('rejects symlinked session paths', () => {
        if (process.platform === 'win32') {
            return;
        }

        const root = mkdtempSync(join(tmpdir(), 'happy-sandbox-symlink-'));
        const realSessionPath = join(root, 'real-session');
        const symlinkSessionPath = join(root, 'symlink-session');

        try {
            mkdirSync(realSessionPath);
            symlinkSync(realSessionPath, symlinkSessionPath, 'dir');

            expect(() =>
                buildSandboxRuntimeConfig(
                    createConfig({
                        sessionIsolation: 'strict',
                    }),
                    symlinkSessionPath,
                ),
            ).toThrow(/session path may not be a symbolic link/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects symlinked allow-write roots', () => {
        if (process.platform === 'win32') {
            return;
        }

        const root = mkdtempSync(join(tmpdir(), 'happy-sandbox-write-symlink-'));
        const realWritePath = join(root, 'real-write');
        const symlinkWritePath = join(root, 'symlink-write');

        try {
            mkdirSync(realWritePath);
            symlinkSync(realWritePath, symlinkWritePath, 'dir');

            expect(() =>
                buildSandboxRuntimeConfig(
                    createConfig({
                        sessionIsolation: 'custom',
                        customWritePaths: [symlinkWritePath],
                    }),
                    sessionPath,
                ),
            ).toThrow(/customWritePaths may not be a symbolic link/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('includes realpath aliases for existing allow and deny paths', () => {
        if (process.platform === 'win32') {
            return;
        }

        const root = mkdtempSync(join(tmpdir(), 'happy-sandbox-realpath-'));
        const realParent = join(root, 'real-parent');
        const symlinkParent = join(root, 'symlink-parent');
        const workspaceViaSymlinkParent = join(symlinkParent, 'workspace');
        const secretViaSymlinkParent = join(symlinkParent, 'secret');

        try {
            mkdirSync(join(realParent, 'workspace'), { recursive: true });
            mkdirSync(join(realParent, 'secret'), { recursive: true });
            symlinkSync(realParent, symlinkParent, 'dir');

            const runtimeConfig = buildSandboxRuntimeConfig(
                createConfig({
                    workspaceRoot: workspaceViaSymlinkParent,
                    denyReadPaths: [secretViaSymlinkParent],
                    denyWritePaths: [],
                }),
                sessionPath,
            );

            expect(runtimeConfig.filesystem?.allowWrite).toEqual(
                expect.arrayContaining([
                    workspaceViaSymlinkParent,
                    realpathSync(workspaceViaSymlinkParent),
                ]),
            );
            expect(runtimeConfig.filesystem?.denyRead).toEqual(
                expect.arrayContaining([
                    secretViaSymlinkParent,
                    realpathSync(secretViaSymlinkParent),
                ]),
            );
            expect(runtimeConfig.filesystem?.denyWrite).toEqual(
                expect.arrayContaining([
                    secretViaSymlinkParent,
                    realpathSync(secretViaSymlinkParent),
                ]),
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('rejects blank sandbox path entries before resolving them', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    denyReadPaths: [''],
                }),
                sessionPath,
            ),
        ).toThrow(/denyReadPaths contains an empty or whitespace-padded path/);
    });

    it('rejects sandbox path entries with control characters', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    denyReadPaths: ['secret\npath'],
                }),
                sessionPath,
            ),
        ).toThrow(/denyReadPaths contains control characters/);
    });

    it('rejects oversized sandbox path entries', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    denyReadPaths: [`/${'a'.repeat(4097)}`],
                }),
                sessionPath,
            ),
        ).toThrow(/denyReadPaths exceeds maximum path length/);
    });

    it('rejects whitespace-padded workspace roots', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    workspaceRoot: ' ~/projects',
                }),
                sessionPath,
            ),
        ).toThrow(/workspaceRoot contains an empty or whitespace-padded path/);
    });

    it('rejects malformed injected agent state paths', () => {
        expect(() =>
            buildSandboxRuntimeConfig(createConfig(), sessionPath, {
                includeSharedAgentStatePaths: false,
                agentStatePaths: [' /tmp/happy-sandbox-state/claude'],
            }),
        ).toThrow(/agentStatePaths contains an empty or whitespace-padded path/);
    });

    it('rejects parent traversal in allow-write path entries', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    extraWritePaths: ['../scratch'],
                }),
                sessionPath,
            ),
        ).toThrow(/extraWritePaths may not contain parent directory traversal/);
    });

    it('allows parent traversal in deny-only path entries', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                denyReadPaths: ['../private-read'],
                denyWritePaths: ['../private-write'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.filesystem?.denyRead).toEqual([
            resolve(sessionPath, '../private-read'),
            ...expectedProtectedCommandPaths(),
            ...expectedHappyStateDenyPaths(),
        ]);
        expect(runtimeConfig.filesystem?.denyWrite).toEqual([
            resolve(sessionPath, '../private-write'),
            resolve(sessionPath, '../private-read'),
            ...expectedProtectedCommandPaths(),
            ...expectedHappyStateDenyPaths(),
        ]);
    });

    it('always denies writes to paths that are denied for read', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(
            createConfig({
                denyReadPaths: ['~/read-secret', '/var/blocked-read'],
                denyWritePaths: ['~/write-secret'],
            }),
            sessionPath,
        );

        expect(runtimeConfig.filesystem?.denyWrite).toEqual([
            `${homedir()}/write-secret`,
            `${homedir()}/read-secret`,
            '/var/blocked-read',
            ...expectedProtectedCommandPaths(),
            ...expectedHappyStateDenyPaths(),
        ]);
    });

    it('always denies read and write access to sensitive Happy local state', () => {
        const runtimeConfig = buildSandboxRuntimeConfig(createConfig(), sessionPath);

        expect(runtimeConfig.filesystem?.denyRead).toEqual(
            expect.arrayContaining(expectedHappyStateDenyPaths()),
        );
        expect(runtimeConfig.filesystem?.denyWrite).toEqual(
            expect.arrayContaining(expectedHappyStateDenyPaths()),
        );
        expect(runtimeConfig.filesystem?.denyRead).not.toContain(resolve(configuration.happyHomeDir));
    });

    it('rejects blank custom network domains', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    networkMode: 'custom',
                    allowedDomains: ['api.openai.com', ''],
                }),
                sessionPath,
            ),
        ).toThrow(/allowedDomains contains an empty or whitespace-padded domain/);
    });

    it('rejects catch-all custom network domains', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    networkMode: 'custom',
                    allowedDomains: ['*'],
                }),
                sessionPath,
            ),
        ).toThrow(/allowedDomains contains a catch-all wildcard domain/);
    });

    it('rejects URL-shaped custom network domains', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    networkMode: 'custom',
                    deniedDomains: ['https://tracking.example.com'],
                }),
                sessionPath,
            ),
        ).toThrow(/deniedDomains must contain hostnames, not URLs/);
    });

    it('rejects oversized custom network domains', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    networkMode: 'custom',
                    allowedDomains: [`${'a'.repeat(250)}.com`],
                }),
                sessionPath,
            ),
        ).toThrow(/allowedDomains exceeds maximum domain length/);
    });

    it('rejects IP literals in custom network domains', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    networkMode: 'custom',
                    allowedDomains: ['127.0.0.1'],
                }),
                sessionPath,
            ),
        ).toThrow(/allowedDomains must contain hostnames, not IP addresses/);

        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    networkMode: 'custom',
                    deniedDomains: ['203.0.113.10'],
                }),
                sessionPath,
            ),
        ).toThrow(/deniedDomains must contain hostnames, not IP addresses/);
    });

    it('rejects exact conflicts between custom network allow and deny rules', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    networkMode: 'custom',
                    allowedDomains: ['api.example.com'],
                    deniedDomains: ['api.example.com'],
                }),
                sessionPath,
            ),
        ).toThrow(/conflicting domain rules/);
    });

    it('rejects wildcard conflicts between custom network allow and deny rules', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    networkMode: 'custom',
                    allowedDomains: ['*.example.com'],
                    deniedDomains: ['api.example.com'],
                }),
                sessionPath,
            ),
        ).toThrow(/conflicting domain rules/);
    });

    it('rejects wildcard top-level domains in custom network policy', () => {
        expect(() =>
            buildSandboxRuntimeConfig(
                createConfig({
                    networkMode: 'custom',
                    allowedDomains: ['*.com'],
                }),
                sessionPath,
            ),
        ).toThrow(/allowedDomains contains an invalid domain/);
    });
});
