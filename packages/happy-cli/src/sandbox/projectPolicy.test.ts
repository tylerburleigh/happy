import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SandboxConfigSchema, type SandboxConfig } from '@/persistence';
import {
    findProjectSandboxPolicy,
    mergeSandboxConfig,
    resolveSandboxConfig,
} from './projectPolicy';

function createConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
    return SandboxConfigSchema.parse({
        enabled: true,
        sessionIsolation: 'workspace',
        workspaceRoot: '~/projects',
        customWritePaths: [],
        denyReadPaths: ['~/.ssh'],
        extraWritePaths: ['/tmp', '~/.cache/gh'],
        denyWritePaths: ['.env'],
        networkMode: 'custom',
        allowedDomains: ['github.com', 'api.openai.com'],
        deniedDomains: [],
        allowLocalBinding: true,
        ...overrides,
    });
}

describe('project sandbox policy', () => {
    it('finds .happy/sandbox.json by walking upward', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-project-policy-'));
        const nested = join(root, 'packages', 'cli');
        mkdirSync(join(root, '.happy'), { recursive: true });
        mkdirSync(nested, { recursive: true });
        const policyPath = join(root, '.happy', 'sandbox.json');
        writeFileSync(policyPath, '{}');

        expect(findProjectSandboxPolicy(nested)).toBe(policyPath);
    });

    it('merges project policy as restrictions', () => {
        const merged = mergeSandboxConfig(createConfig({
            customWritePaths: ['~/projects/app', '~/projects/lib'],
            envPassthrough: ['PATH', 'OPENAI_API_KEY'],
        }), {
            sessionIsolation: 'strict',
            workspaceRoot: '~/projects/app',
            customWritePaths: ['~/projects/app', '~/elsewhere'],
            extraWritePaths: ['/tmp', '/var/tmp'],
            denyReadPaths: ['~/.kube'],
            denyWritePaths: ['~/.zshrc'],
            networkMode: 'custom',
            allowedDomains: ['github.com'],
            allowLocalBinding: false,
            envPassthrough: ['PATH'],
        });

        expect(merged.sessionIsolation).toBe('strict');
        expect(merged.workspaceRoot).toBe('~/projects/app');
        expect(merged.customWritePaths).toEqual(['~/projects/app']);
        expect(merged.extraWritePaths).toEqual(['/tmp']);
        expect(merged.denyReadPaths).toEqual(['~/.ssh', '~/.kube']);
        expect(merged.denyWritePaths).toEqual(['.env', '~/.zshrc']);
        expect(merged.allowedDomains).toEqual(['github.com']);
        expect(merged.allowLocalBinding).toBe(false);
        expect(merged.envPassthrough).toEqual(['PATH']);
    });

    it('does not let project policy weaken fallback, homes, or workspace scope', () => {
        const merged = mergeSandboxConfig(createConfig({
            allowSandboxFallback: false,
            agentHomeMode: 'isolated',
            isolatedCodexHome: '~/.happy/agent-homes/codex',
            isolatedClaudeConfigDir: '~/.happy/agent-homes/claude',
        }), {
            workspaceRoot: '~/',
            allowSandboxFallback: true,
            agentHomeMode: 'shared',
            isolatedCodexHome: '~/.codex',
            isolatedClaudeConfigDir: '~/.claude',
        });

        expect(merged.workspaceRoot).toBe('~/projects');
        expect(merged.allowSandboxFallback).toBe(false);
        expect(merged.agentHomeMode).toBe('isolated');
        expect(merged.isolatedCodexHome).toBe('~/.happy/agent-homes/codex');
        expect(merged.isolatedClaudeConfigDir).toBe('~/.happy/agent-homes/claude');
    });

    it('applies project policy when resolving sandbox config', () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-project-policy-'));
        mkdirSync(join(root, '.happy'), { recursive: true });
        writeFileSync(join(root, '.happy', 'sandbox.json'), JSON.stringify({
            denyWritePaths: ['~/.gitconfig'],
            networkMode: 'blocked',
        }));

        const resolved = resolveSandboxConfig(createConfig(), root);

        expect(resolved?.networkMode).toBe('blocked');
        expect(resolved?.denyWritePaths).toContain('~/.gitconfig');
    });
});
