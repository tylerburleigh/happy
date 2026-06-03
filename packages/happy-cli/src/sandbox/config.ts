import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { configuration } from '@/configuration';
import type { SandboxConfig } from '@/persistence';
import { getSandboxHomeDir, getSandboxTempDir } from './temp';

export type SandboxRuntimeBuildOptions = {
    agentStatePaths?: string[];
    denyReadPaths?: string[];
    includeSharedAgentStatePaths?: boolean;
};

const MAX_SANDBOX_PATH_LENGTH = 4096;
const MAX_SANDBOX_DOMAIN_LENGTH = 253;
const DEFAULT_ISOLATED_CODEX_HOME = '~/.happy/agent-homes/codex';
const DEFAULT_ISOLATED_CLAUDE_CONFIG_DIR = '~/.happy/agent-homes/claude';

function assertWellFormedPath(pathValue: string, label: string): void {
    if (pathValue.trim().length === 0 || pathValue !== pathValue.trim()) {
        throw new Error(`Sandbox ${label} contains an empty or whitespace-padded path`);
    }

    if (pathValue.length > MAX_SANDBOX_PATH_LENGTH) {
        throw new Error(`Sandbox ${label} exceeds maximum path length`);
    }

    if (/[\u0000-\u001f\u007f]/.test(pathValue)) {
        throw new Error(`Sandbox ${label} contains control characters`);
    }
}

function assertNoParentTraversalPath(pathValue: string, label: string): void {
    if (pathValue.split(/[\\/]+/).includes('..')) {
        throw new Error(`Sandbox ${label} may not contain parent directory traversal`);
    }
}

function assertNotSymlinkPath(pathValue: string, label: string): void {
    if (!existsSync(pathValue)) {
        return;
    }

    if (lstatSync(pathValue).isSymbolicLink()) {
        let target = '';
        try {
            target = ` -> ${realpathSync(pathValue)}`;
        } catch {
            // Keep the original path in the error if the symlink cannot be resolved.
        }
        throw new Error(`Sandbox ${label} may not be a symbolic link: ${pathValue}${target}`);
    }
}

function expandPath(pathValue: string, sessionPath: string, label: string): string {
    assertWellFormedPath(pathValue, label);
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    if (isAbsolute(expandedHome)) {
        return expandedHome;
    }

    return resolve(sessionPath, expandedHome);
}

export function expandSandboxPath(pathValue: string, sessionPath: string): string {
    return expandPath(pathValue, sessionPath, 'path');
}

function isSimpleRelativePath(pathValue: string): boolean {
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    return !isAbsolute(expandedHome) && !pathValue.split(/[\\/]+/).includes('..');
}

function resolveDenyPaths(
    paths: string[],
    sessionPath: string,
    label: string,
    additionalSimpleRelativeBases: string[] = [],
): string[] {
    return paths.flatMap((pathValue) => {
        const resolved = pathVariants(expandPath(pathValue, sessionPath, label));
        if (!isSimpleRelativePath(pathValue)) {
            return resolved;
        }

        return [
            ...resolved,
            ...additionalSimpleRelativeBases.flatMap((basePath) => pathVariants(resolve(basePath, pathValue))),
        ];
    });
}

function expandAllowWritePath(pathValue: string, sessionPath: string, label: string): string {
    assertNoParentTraversalPath(pathValue, label);
    const expanded = expandPath(pathValue, sessionPath, label);
    assertNotSymlinkPath(expanded, label);
    return expanded;
}

function expandAllowWritePathVariants(pathValue: string, sessionPath: string, label: string): string[] {
    return pathVariants(expandAllowWritePath(pathValue, sessionPath, label));
}

function resolveAllowWritePaths(paths: string[], sessionPath: string, label: string): string[] {
    return paths.flatMap((pathValue) => expandAllowWritePathVariants(pathValue, sessionPath, label));
}

export function getSandboxAgentHomePaths(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
): { codexHome: string; claudeConfigDir: string } {
    const agentHomeMode = sandboxConfig.agentHomeMode ?? 'isolated';
    const codexHome = agentHomeMode === 'shared'
        ? process.env.CODEX_HOME || '~/.codex'
        : sandboxConfig.isolatedCodexHome ?? DEFAULT_ISOLATED_CODEX_HOME;
    const claudeConfigDir = agentHomeMode === 'shared'
        ? process.env.CLAUDE_CONFIG_DIR || '~/.claude'
        : sandboxConfig.isolatedClaudeConfigDir ?? DEFAULT_ISOLATED_CLAUDE_CONFIG_DIR;

    return {
        codexHome: expandAllowWritePath(codexHome, sessionPath, 'CODEX_HOME'),
        claudeConfigDir: expandAllowWritePath(claudeConfigDir, sessionPath, 'CLAUDE_CONFIG_DIR'),
    };
}

function getSharedAgentStatePaths(sessionPath: string): string[] {
    const codexHome = process.env.CODEX_HOME || '~/.codex';
    const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || '~/.claude';

    return [
        ...expandAllowWritePathVariants(codexHome, sessionPath, 'CODEX_HOME'),
        ...expandAllowWritePathVariants(claudeConfigDir, sessionPath, 'CLAUDE_CONFIG_DIR'),
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

function pathVariants(pathValue: string): string[] {
    const variants = [pathValue];

    try {
        const realPath = realpathSync(pathValue);
        if (!variants.includes(realPath)) {
            variants.push(realPath);
        }
    } catch {
        // Missing paths are still useful policy entries by configured spelling.
    }

    return variants;
}

function dangerousAllowWriteRoots(): Set<string> {
    const home = resolve(homedir());
    const homeParent = resolve(home, '..');
    return new Set([
        '/',
        '/Applications',
        '/Library',
        '/System',
        '/Users',
        '/bin',
        '/dev/shm',
        '/etc',
        '/home',
        '/private',
        '/private/tmp',
        '/private/var/tmp',
        '/sbin',
        '/tmp',
        '/usr',
        '/var',
        '/var/tmp',
        home,
        homeParent,
    ]);
}

function assertNoDangerouslyBroadAllowWritePaths(paths: string[]): void {
    const dangerousRoots = dangerousAllowWriteRoots();
    const broadPaths = paths.filter((pathValue) => dangerousRoots.has(resolve(pathValue)));

    if (broadPaths.length > 0) {
        throw new Error(`Sandbox allow-write path is too broad: ${broadPaths.join(', ')}`);
    }
}

function isPathInsideOrEqual(parentPath: string, childPath: string): boolean {
    const normalizedParent = resolve(parentPath);
    const normalizedChild = resolve(childPath);
    const relativePath = relative(normalizedParent, normalizedChild);
    return relativePath === ''
        || (relativePath.length > 0 && !relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function assertNoAllowWriteDeniedPathConflicts(allowWrite: string[], denyWrite: string[]): void {
    const conflicts = allowWrite.filter((allowPath) =>
        denyWrite.some((denyPath) => isPathInsideOrEqual(denyPath, allowPath)),
    );

    if (conflicts.length > 0) {
        throw new Error(`Sandbox allow-write path conflicts with denied path: ${conflicts.join(', ')}`);
    }
}

function assertWellFormedDomain(domain: string, label: string): void {
    if (domain.trim().length === 0 || domain !== domain.trim()) {
        throw new Error(`Sandbox ${label} contains an empty or whitespace-padded domain`);
    }

    if (domain.length > MAX_SANDBOX_DOMAIN_LENGTH) {
        throw new Error(`Sandbox ${label} exceeds maximum domain length`);
    }

    if (domain === '*' || domain === '*.*') {
        throw new Error(`Sandbox ${label} contains a catch-all wildcard domain`);
    }

    if (domain.includes('/') || domain.includes(':')) {
        throw new Error(`Sandbox ${label} must contain hostnames, not URLs`);
    }

    const hostname = domain.startsWith('*.') ? domain.slice(2) : domain;
    const isIpv4Address = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)
        && hostname.split('.').every((part) => Number(part) <= 255);
    if (isIpv4Address) {
        throw new Error(`Sandbox ${label} must contain hostnames, not IP addresses`);
    }

    const validHostname = hostname === 'localhost'
        || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(hostname);

    if (!validHostname) {
        throw new Error(`Sandbox ${label} contains an invalid domain: ${domain}`);
    }
}

function assertWellFormedDomains(domains: string[], label: string): void {
    for (const domain of domains) {
        assertWellFormedDomain(domain, label);
    }
}

function domainPolicyMatches(pattern: string, candidate: string): boolean {
    const normalizedPattern = pattern.toLowerCase();
    const normalizedCandidate = candidate.toLowerCase();

    if (normalizedPattern === normalizedCandidate) {
        return true;
    }

    if (!normalizedPattern.startsWith('*.')) {
        return false;
    }

    const base = normalizedPattern.slice(2);
    const candidateHostname = normalizedCandidate.startsWith('*.')
        ? normalizedCandidate.slice(2)
        : normalizedCandidate;
    return candidateHostname.endsWith(`.${base}`);
}

function assertNoDomainPolicyConflicts(allowedDomains: string[], deniedDomains: string[]): void {
    for (const allowedDomain of allowedDomains) {
        for (const deniedDomain of deniedDomains) {
            if (
                domainPolicyMatches(allowedDomain, deniedDomain)
                || domainPolicyMatches(deniedDomain, allowedDomain)
            ) {
                throw new Error(`Sandbox custom network policy has conflicting domain rules: ${allowedDomain} and ${deniedDomain}`);
            }
        }
    }
}

function normalizeDomains(domains: string[]): string[] {
    return uniquePaths(domains.map((domain) => domain.toLowerCase()));
}

function getHappyStateDenyPaths(): string[] {
    const happyHomeDir = resolve(configuration.happyHomeDir);
    return uniquePaths([
        join(happyHomeDir, 'access.key'),
        join(happyHomeDir, 'daemon.state.json'),
        join(happyHomeDir, 'logs'),
        join(happyHomeDir, 'server-data'),
        join(happyHomeDir, 'sessions.json'),
        join(happyHomeDir, 'settings.json'),
    ].flatMap(pathVariants));
}

export function buildSandboxRuntimeConfig(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
    options: SandboxRuntimeBuildOptions = {},
): SandboxRuntimeConfig {
    assertWellFormedPath(sessionPath, 'session path');
    assertNoParentTraversalPath(sessionPath, 'session path');
    assertNotSymlinkPath(resolve(sessionPath), 'session path');
    const sessionPathVariants = pathVariants(resolve(sessionPath));

    const extraWritePaths = uniquePaths([
        ...pathVariants(getSandboxHomeDir(sessionPath)),
        ...pathVariants(getSandboxTempDir(sessionPath)),
        ...resolveAllowWritePaths(sandboxConfig.extraWritePaths, sessionPath, 'extraWritePaths'),
    ]);
    const sharedAgentStatePaths = options.includeSharedAgentStatePaths === true
        ? getSharedAgentStatePaths(sessionPath)
        : [];
    const agentStatePaths = resolveAllowWritePaths(options.agentStatePaths ?? [], sessionPath, 'agentStatePaths');
    const workspaceRootPathVariants = sandboxConfig.sessionIsolation === 'workspace'
        ? sandboxConfig.workspaceRoot
            ? expandAllowWritePathVariants(sandboxConfig.workspaceRoot, sessionPath, 'workspaceRoot')
            : sessionPathVariants
        : [];
    const additionalDenyRelativeBases = uniquePaths(workspaceRootPathVariants.filter((pathValue) =>
        !sessionPathVariants.includes(pathValue),
    ));

    const allowWrite = (() => {
        switch (sandboxConfig.sessionIsolation) {
            case 'strict':
                return uniquePaths([...sessionPathVariants, ...extraWritePaths, ...sharedAgentStatePaths, ...agentStatePaths]);
            case 'workspace': {
                return uniquePaths([...workspaceRootPathVariants, ...sessionPathVariants, ...extraWritePaths, ...sharedAgentStatePaths, ...agentStatePaths]);
            }
            case 'custom':
                return uniquePaths([
                    ...resolveAllowWritePaths(sandboxConfig.customWritePaths, sessionPath, 'customWritePaths'),
                    ...extraWritePaths,
                    ...sharedAgentStatePaths,
                    ...agentStatePaths,
                ]);
        }
    })();

    assertNoDangerouslyBroadAllowWritePaths(allowWrite);

    const network = (() => {
        switch (sandboxConfig.networkMode) {
            case 'blocked':
                return {
                    allowedDomains: [] as string[],
                    deniedDomains: [] as string[],
                    allowLocalBinding: false,
                    allowUnixSockets: [] as string[],
                };
            case 'allowed':
                assertWellFormedDomains(sandboxConfig.deniedDomains, 'deniedDomains');
                return {
                    allowedDomains: undefined as unknown as string[],
                    deniedDomains: normalizeDomains(sandboxConfig.deniedDomains),
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
            case 'custom':
                assertWellFormedDomains(sandboxConfig.allowedDomains, 'allowedDomains');
                assertWellFormedDomains(sandboxConfig.deniedDomains, 'deniedDomains');
                assertNoDomainPolicyConflicts(sandboxConfig.allowedDomains, sandboxConfig.deniedDomains);
                const allowedDomains = normalizeDomains(sandboxConfig.allowedDomains);
                const deniedDomains = normalizeDomains(sandboxConfig.deniedDomains);
                return {
                    allowedDomains,
                    deniedDomains,
                    allowLocalBinding: sandboxConfig.allowLocalBinding,
                    allowUnixSockets: [] as string[],
                };
        }
    })();

    const enableWeakerNetworkIsolation = sandboxConfig.networkMode === 'allowed'
        ? true
        : undefined;
    const denyRead = uniquePaths([
        ...resolveDenyPaths(sandboxConfig.denyReadPaths, sessionPath, 'denyReadPaths', additionalDenyRelativeBases),
        ...resolveDenyPaths(options.denyReadPaths ?? [], sessionPath, 'denyReadPaths'),
        ...getProtectedCommandPaths().flatMap(pathVariants),
        ...getHappyStateDenyPaths(),
    ]);
    const denyWrite = uniquePaths([
        ...resolveDenyPaths(sandboxConfig.denyWritePaths, sessionPath, 'denyWritePaths', additionalDenyRelativeBases),
        ...denyRead,
    ]);
    assertNoAllowWriteDeniedPathConflicts(allowWrite, denyWrite);

    return {
        allowPty: true,
        enableWeakerNetworkIsolation,
        network,
        filesystem: {
            denyRead,
            allowWrite,
            denyWrite,
        },
    };
}
