import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '@/persistence';

export function expandSandboxPath(pathValue: string, sessionPath: string): string {
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    if (isAbsolute(expandedHome)) {
        return expandedHome;
    }

    return resolve(sessionPath, expandedHome);
}

function resolvePaths(paths: string[], sessionPath: string): string[] {
    return paths.map((pathValue) => expandSandboxPath(pathValue, sessionPath));
}

export function getSandboxAgentHomePaths(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
): { codexHome: string; claudeConfigDir: string } {
    const codexHome = sandboxConfig.agentHomeMode === 'shared'
        ? process.env.CODEX_HOME || '~/.codex'
        : sandboxConfig.isolatedCodexHome;
    const claudeConfigDir = sandboxConfig.agentHomeMode === 'shared'
        ? process.env.CLAUDE_CONFIG_DIR || '~/.claude'
        : sandboxConfig.isolatedClaudeConfigDir;

    return {
        codexHome: expandSandboxPath(codexHome, sessionPath),
        claudeConfigDir: expandSandboxPath(claudeConfigDir, sessionPath),
    };
}

function getSharedAgentStatePaths(sandboxConfig: SandboxConfig, sessionPath: string): string[] {
    const { codexHome, claudeConfigDir } = getSandboxAgentHomePaths(sandboxConfig, sessionPath);

    return [
        codexHome,
        claudeConfigDir,
    ];
}

function uniquePaths(paths: string[]): string[] {
    return [...new Set(paths)];
}

const MACOS_PROTECTED_COMMAND_PATHS = [
    '/usr/bin/security',
    '/usr/bin/pbpaste',
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    '/opt/homebrew/bin/gcloud',
    '/usr/local/bin/gcloud',
    '/opt/homebrew/bin/aws',
    '/usr/local/bin/aws',
    '/opt/homebrew/bin/kubectl',
    '/usr/local/bin/kubectl',
    '/opt/homebrew/bin/docker',
    '/usr/local/bin/docker',
    '/opt/homebrew/bin/op',
    '/usr/local/bin/op',
    '/opt/homebrew/bin/ksm',
    '/usr/local/bin/ksm',
    '/usr/bin/ssh-add',
];

const LINUX_PROTECTED_COMMAND_PATHS = [
    '/usr/bin/gh',
    '/usr/local/bin/gh',
    '/snap/bin/gh',
    '/usr/bin/gcloud',
    '/usr/local/bin/gcloud',
    '/snap/bin/gcloud',
    '/usr/bin/aws',
    '/usr/local/bin/aws',
    '/snap/bin/aws',
    '/usr/bin/kubectl',
    '/usr/local/bin/kubectl',
    '/snap/bin/kubectl',
    '/usr/bin/docker',
    '/usr/local/bin/docker',
    '/snap/bin/docker',
    '/usr/bin/op',
    '/usr/local/bin/op',
    '/snap/bin/op',
    '/usr/bin/ksm',
    '/usr/local/bin/ksm',
    '/usr/bin/ssh-add',
    '/usr/bin/secret-tool',
    '/usr/bin/pass',
    '/usr/local/bin/pass',
    '/usr/bin/gopass',
    '/usr/local/bin/gopass',
    '/usr/bin/kwallet-query',
    '/usr/bin/keyctl',
    '/usr/bin/xclip',
    '/usr/bin/xsel',
    '/usr/bin/wl-paste',
];

export function getProtectedCommandPaths(platform: NodeJS.Platform = process.platform): string[] {
    switch (platform) {
        case 'darwin':
            return MACOS_PROTECTED_COMMAND_PATHS;
        case 'linux':
            return LINUX_PROTECTED_COMMAND_PATHS;
        default:
            return [];
    }
}

export function buildSandboxRuntimeConfig(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
): SandboxRuntimeConfig {
    const extraWritePaths = resolvePaths(sandboxConfig.extraWritePaths, sessionPath);
    const sharedAgentStatePaths = getSharedAgentStatePaths(sandboxConfig, sessionPath);

    const allowWrite = (() => {
        switch (sandboxConfig.sessionIsolation) {
            case 'strict':
                return uniquePaths([resolve(sessionPath), ...extraWritePaths, ...sharedAgentStatePaths]);
            case 'workspace': {
                const workspaceRoot = sandboxConfig.workspaceRoot
                    ? expandSandboxPath(sandboxConfig.workspaceRoot, sessionPath)
                    : resolve(sessionPath);
                return uniquePaths([workspaceRoot, resolve(sessionPath), ...extraWritePaths, ...sharedAgentStatePaths]);
            }
            case 'custom':
                return uniquePaths([
                    ...resolvePaths(sandboxConfig.customWritePaths, sessionPath),
                    ...extraWritePaths,
                    ...sharedAgentStatePaths,
                ]);
        }
    })();

    const network = (() => {
        switch (sandboxConfig.networkMode) {
            case 'blocked':
                return {
                    allowedDomains: [] as string[],
                    deniedDomains: [] as string[],
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'allowed':
                return {
                    allowedDomains: undefined as unknown as string[],
                    deniedDomains: [] as string[],
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'custom':
                return {
                    allowedDomains: sandboxConfig.allowedDomains,
                    deniedDomains: sandboxConfig.deniedDomains,
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
        }
    })();

    const enableWeakerNetworkIsolation = sandboxConfig.networkMode === 'allowed'
        ? true
        : undefined;

    return {
        allowPty: true,
        enableWeakerNetworkIsolation,
        network,
        filesystem: {
            denyRead: uniquePaths([
                ...resolvePaths(sandboxConfig.denyReadPaths, sessionPath),
                ...getProtectedCommandPaths(),
            ]),
            allowWrite,
            denyWrite: resolvePaths(sandboxConfig.denyWritePaths, sessionPath),
        },
    };
}
