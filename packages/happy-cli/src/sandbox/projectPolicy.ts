import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import * as z from 'zod';
import { SandboxConfigSchema, type SandboxConfig } from '@/persistence';
import { logger } from '@/ui/logger';

const ProjectSandboxConfigSchema = SandboxConfigSchema.partial();
type ProjectSandboxConfig = z.infer<typeof ProjectSandboxConfigSchema>;

const ISOLATION_RANK: Record<SandboxConfig['sessionIsolation'], number> = {
    strict: 0,
    custom: 1,
    workspace: 2,
};

const NETWORK_RANK: Record<SandboxConfig['networkMode'], number> = {
    blocked: 0,
    custom: 1,
    allowed: 2,
};

export function resolveSandboxConfig(
    globalConfig: SandboxConfig | undefined,
    startDir: string,
): SandboxConfig | undefined {
    const projectPolicyPath = findProjectSandboxPolicy(startDir);
    if (!projectPolicyPath) {
        return scopeWorkspaceRootToGitWorktree(globalConfig, startDir);
    }

    const projectConfig = readProjectSandboxPolicy(projectPolicyPath);
    if (!projectConfig) {
        return scopeWorkspaceRootToGitWorktree(globalConfig, startDir);
    }

    if (!globalConfig) {
        return scopeWorkspaceRootToGitWorktree(SandboxConfigSchema.parse(projectConfig), startDir);
    }

    const merged = mergeSandboxConfig(globalConfig, projectConfig);
    logger.debug(`[sandbox] Applied project sandbox policy: ${projectPolicyPath}`);
    return scopeWorkspaceRootToGitWorktree(merged, startDir);
}

export function findProjectSandboxPolicy(startDir: string): string | null {
    let current = resolve(startDir);
    const root = parse(current).root;

    while (true) {
        const candidate = join(current, '.happy', 'sandbox.json');
        if (existsSync(candidate)) {
            return candidate;
        }
        if (current === root || current === homedir()) {
            return null;
        }
        current = dirname(current);
    }
}

function readProjectSandboxPolicy(path: string): ProjectSandboxConfig | null {
    try {
        return ProjectSandboxConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch (error) {
        logger.warn(`[sandbox] Ignoring invalid project sandbox policy at ${path}.`, error);
        return null;
    }
}

export function mergeSandboxConfig(
    globalConfig: SandboxConfig,
    projectConfig: ProjectSandboxConfig,
): SandboxConfig {
    const networkMode = stricter(globalConfig.networkMode, projectConfig.networkMode, NETWORK_RANK);
    const allowedDomains = mergeAllowedDomains(globalConfig, projectConfig, networkMode);

    return SandboxConfigSchema.parse({
        ...globalConfig,
        enabled: globalConfig.enabled || projectConfig.enabled === true,
        sessionIsolation: stricter(globalConfig.sessionIsolation, projectConfig.sessionIsolation, ISOLATION_RANK),
        workspaceRoot: restrictWorkspaceRoot(globalConfig.workspaceRoot, projectConfig.workspaceRoot),
        customWritePaths: restrictList(globalConfig.customWritePaths, projectConfig.customWritePaths),
        extraWritePaths: restrictList(globalConfig.extraWritePaths, projectConfig.extraWritePaths),
        denyReadPaths: union(globalConfig.denyReadPaths, projectConfig.denyReadPaths),
        denyWritePaths: union(globalConfig.denyWritePaths, projectConfig.denyWritePaths),
        networkMode,
        allowedDomains,
        deniedDomains: union(globalConfig.deniedDomains, projectConfig.deniedDomains),
        allowLocalBinding: projectConfig.allowLocalBinding === undefined
            ? globalConfig.allowLocalBinding
            : globalConfig.allowLocalBinding && projectConfig.allowLocalBinding,
        allowSandboxFallback: projectConfig.allowSandboxFallback === undefined
            ? globalConfig.allowSandboxFallback
            : globalConfig.allowSandboxFallback && projectConfig.allowSandboxFallback,
        agentHomeMode: globalConfig.agentHomeMode,
        isolatedCodexHome: restrictIsolatedHome(globalConfig.isolatedCodexHome, projectConfig.isolatedCodexHome),
        isolatedClaudeConfigDir: restrictIsolatedHome(globalConfig.isolatedClaudeConfigDir, projectConfig.isolatedClaudeConfigDir),
        envPassthrough: restrictEnvPassthrough(globalConfig.envPassthrough, projectConfig.envPassthrough),
    });
}

function stricter<T extends string>(
    baseValue: T,
    projectValue: T | undefined,
    rank: Record<T, number>,
): T {
    if (!projectValue) return baseValue;
    return rank[projectValue] < rank[baseValue] ? projectValue : baseValue;
}

function union(base: string[], extra: string[] | undefined): string[] {
    return [...new Set([...base, ...(extra ?? [])])];
}

function restrictList(base: string[], project: string[] | undefined): string[] {
    if (!project) return base;
    const allowed = new Set(project);
    return base.filter((pathValue) => allowed.has(pathValue));
}

function restrictWorkspaceRoot(base: string | undefined, project: string | undefined): string | undefined {
    if (!project) return base;
    if (!base) return undefined;
    return isSameOrChildPolicyPath(project, base) ? project : base;
}

function restrictIsolatedHome(base: string, project: string | undefined): string {
    if (!project) return base;
    return isSameOrChildPolicyPath(project, base) ? project : base;
}

function normalizePolicyPath(pathValue: string): string {
    const expandedHome = pathValue.replace(/^~(?=\/|$)/, homedir());
    return isAbsolute(expandedHome) ? resolve(expandedHome) : resolve(expandedHome);
}

function isSameOrChildPolicyPath(candidate: string, base: string): boolean {
    const normalizedCandidate = normalizePolicyPath(candidate);
    const normalizedBase = normalizePolicyPath(base);
    const rel = relative(normalizedBase, normalizedCandidate);
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

export function findGitWorktreeRoot(startDir: string): string | null {
    let current = resolve(startDir);
    const root = parse(current).root;

    while (true) {
        const gitPath = join(current, '.git');
        if (existsSync(gitPath)) {
            return current;
        }
        if (current === root || current === homedir()) {
            return null;
        }
        current = dirname(current);
    }
}

export function scopeWorkspaceRootToGitWorktree(
    config: SandboxConfig | undefined,
    startDir: string,
): SandboxConfig | undefined {
    if (!config?.enabled || config.sessionIsolation !== 'workspace') {
        return config;
    }

    const worktreeRoot = findGitWorktreeRoot(startDir);
    if (!worktreeRoot) {
        return config;
    }

    if (config.workspaceRoot && isSameOrChildPolicyPath(config.workspaceRoot, worktreeRoot)) {
        return config;
    }

    return SandboxConfigSchema.parse({
        ...config,
        workspaceRoot: worktreeRoot,
    });
}

function restrictEnvPassthrough(base: string[], project: string[] | undefined): string[] {
    if (!project) return base;
    const allowed = new Set(project);
    return base.filter((key) => allowed.has(key));
}

function mergeAllowedDomains(
    globalConfig: SandboxConfig,
    projectConfig: ProjectSandboxConfig,
    networkMode: SandboxConfig['networkMode'],
): string[] {
    if (networkMode !== 'custom') return [];

    if (globalConfig.networkMode === 'custom' && projectConfig.allowedDomains) {
        const projectAllowed = new Set(projectConfig.allowedDomains);
        return globalConfig.allowedDomains.filter((domain) => projectAllowed.has(domain));
    }

    if (globalConfig.networkMode === 'custom') {
        return globalConfig.allowedDomains;
    }

    return projectConfig.allowedDomains ?? [];
}
