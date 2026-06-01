import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
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
        return globalConfig;
    }

    const projectConfig = readProjectSandboxPolicy(projectPolicyPath);
    if (!projectConfig) {
        return globalConfig;
    }

    if (!globalConfig) {
        return SandboxConfigSchema.parse(projectConfig);
    }

    const merged = mergeSandboxConfig(globalConfig, projectConfig);
    logger.debug(`[sandbox] Applied project sandbox policy: ${projectPolicyPath}`);
    return merged;
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
        workspaceRoot: projectConfig.workspaceRoot ?? globalConfig.workspaceRoot,
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
        allowSandboxFallback: projectConfig.allowSandboxFallback ?? globalConfig.allowSandboxFallback,
        agentHomeMode: projectConfig.agentHomeMode ?? globalConfig.agentHomeMode,
        isolatedCodexHome: projectConfig.isolatedCodexHome ?? globalConfig.isolatedCodexHome,
        isolatedClaudeConfigDir: projectConfig.isolatedClaudeConfigDir ?? globalConfig.isolatedClaudeConfigDir,
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
    return project;
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
