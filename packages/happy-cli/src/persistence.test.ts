import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SANDBOX_DENY_READ_PATHS,
    DEFAULT_SANDBOX_DENY_WRITE_PATHS,
    DEFAULT_SANDBOX_EXTRA_WRITE_PATHS,
    DEFAULT_SANDBOX_HAPPY_STATE_DENY_PATHS,
    SandboxConfigSchema,
    normalizeSandboxConfig,
} from './persistence';

describe('SandboxConfigSchema', () => {
    it('applies defaults when values are omitted', () => {
        const parsed = SandboxConfigSchema.parse({});

        expect(parsed).toEqual({
            enabled: false,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: [...DEFAULT_SANDBOX_DENY_READ_PATHS],
            extraWritePaths: [...DEFAULT_SANDBOX_EXTRA_WRITE_PATHS],
            denyWritePaths: [...DEFAULT_SANDBOX_DENY_WRITE_PATHS],
            networkMode: 'allowed',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: true,
            allowSandboxFallback: false,
            agentHomeMode: 'isolated',
            isolatedCodexHome: '~/.happy/agent-homes/codex',
            isolatedClaudeConfigDir: '~/.happy/agent-homes/claude',
            envPassthrough: [],
        });
    });

    it('accepts a fully custom valid sandbox config', () => {
        const parsed = SandboxConfigSchema.parse({
            enabled: true,
            workspaceRoot: '~/projects',
            sessionIsolation: 'custom',
            customWritePaths: ['~/projects/foo', '/var/tmp'],
            denyReadPaths: ['~/.ssh'],
            extraWritePaths: ['/tmp', '/private/tmp'],
            denyWritePaths: ['.env', '.secrets'],
            networkMode: 'custom',
            allowedDomains: ['api.openai.com', '*.github.com'],
            deniedDomains: ['tracking.example.com'],
            allowLocalBinding: false,
            allowSandboxFallback: true,
            agentHomeMode: 'shared',
            envPassthrough: ['OPENAI_API_KEY'],
        });

        expect(parsed.enabled).toBe(true);
        expect(parsed.workspaceRoot).toBe('~/projects');
        expect(parsed.sessionIsolation).toBe('custom');
        expect(parsed.networkMode).toBe('custom');
        expect(parsed.allowedDomains).toEqual(['api.openai.com', '*.github.com']);
        expect(parsed.allowLocalBinding).toBe(false);
        expect(parsed.allowSandboxFallback).toBe(true);
        expect(parsed.agentHomeMode).toBe('shared');
        expect(parsed.envPassthrough).toEqual(['OPENAI_API_KEY']);
    });

    it('rejects invalid enum values', () => {
        expect(() =>
            SandboxConfigSchema.parse({
                sessionIsolation: 'invalid',
            }),
        ).toThrow();

        expect(() =>
            SandboxConfigSchema.parse({
                networkMode: 'invalid',
            }),
        ).toThrow();
    });

    it('rejects invalid field types', () => {
        expect(() =>
            SandboxConfigSchema.parse({
                allowLocalBinding: 'yes',
            }),
        ).toThrow();

        expect(() =>
            SandboxConfigSchema.parse({
                denyReadPaths: [123],
            }),
        ).toThrow();
    });
});

describe('normalizeSandboxConfig', () => {
    it('adds current deny-read defaults to legacy default-derived configs', () => {
        const parsed = SandboxConfigSchema.parse({
            denyReadPaths: ['~/.ssh', '~/.aws', '~/.gnupg', '~/private-extra'],
        });

        const normalized = normalizeSandboxConfig(parsed);

        expect(normalized.denyReadPaths).toEqual(
            expect.arrayContaining([...DEFAULT_SANDBOX_DENY_READ_PATHS, '~/private-extra']),
        );
    });

    it('replaces broad Happy home deny defaults with sensitive Happy state paths', () => {
        const parsed = SandboxConfigSchema.parse({
            denyReadPaths: ['~/.ssh', '~/.aws', '~/.gnupg', '~/.happy'],
            denyWritePaths: ['.env', '~/.happy'],
        });

        const normalized = normalizeSandboxConfig(parsed);

        expect(normalized.denyReadPaths).toEqual(
            expect.arrayContaining([...DEFAULT_SANDBOX_HAPPY_STATE_DENY_PATHS]),
        );
        expect(normalized.denyWritePaths).toEqual(
            expect.arrayContaining([...DEFAULT_SANDBOX_HAPPY_STATE_DENY_PATHS]),
        );
        expect(normalized.denyReadPaths).not.toContain('~/.happy');
        expect(normalized.denyWritePaths).not.toContain('~/.happy');
    });

    it('adds current deny-write defaults to legacy default-derived configs', () => {
        const parsed = SandboxConfigSchema.parse({
            denyWritePaths: ['.env', '~/write-extra'],
        });

        const normalized = normalizeSandboxConfig(parsed);

        expect(normalized.denyWritePaths).toEqual(
            expect.arrayContaining([...DEFAULT_SANDBOX_DENY_WRITE_PATHS, '~/write-extra']),
        );
    });

    it('replaces the legacy broad temp write default with the managed runtime temp default', () => {
        const parsed = SandboxConfigSchema.parse({
            extraWritePaths: ['/tmp'],
        });

        const normalized = normalizeSandboxConfig(parsed);

        expect(normalized.extraWritePaths).toEqual([...DEFAULT_SANDBOX_EXTRA_WRITE_PATHS]);
    });

    it('removes legacy broad temp roots while preserving narrower custom extra write paths', () => {
        const parsed = SandboxConfigSchema.parse({
            extraWritePaths: ['/tmp', '/private/tmp', '/var/tmp', '~/scratch', '~/.cache/tool'],
        });

        const normalized = normalizeSandboxConfig(parsed);

        expect(normalized.extraWritePaths).toEqual(['~/scratch', '~/.cache/tool']);
    });

    it('removes legacy local IP entries from allowed domains', () => {
        const parsed = SandboxConfigSchema.parse({
            networkMode: 'custom',
            allowedDomains: ['0.0.0.0', '127.0.0.1', '::1', 'localhost', 'api.openai.com'],
        });

        const normalized = normalizeSandboxConfig(parsed);

        expect(normalized.allowedDomains).toEqual(['localhost', 'api.openai.com']);
    });

    it('leaves intentionally custom deny-read paths unchanged', () => {
        const parsed = SandboxConfigSchema.parse({
            denyReadPaths: ['~/only-this-secret'],
        });

        const normalized = normalizeSandboxConfig(parsed);

        expect(normalized.denyReadPaths).toEqual(['~/only-this-secret']);
    });

    it('leaves intentionally custom deny-write paths unchanged', () => {
        const parsed = SandboxConfigSchema.parse({
            denyWritePaths: ['~/only-this-write-secret'],
        });

        const normalized = normalizeSandboxConfig(parsed);

        expect(normalized.denyWritePaths).toEqual(['~/only-this-write-secret']);
    });

    it('leaves intentionally custom extra write paths unchanged', () => {
        const parsed = SandboxConfigSchema.parse({
            extraWritePaths: ['~/scratch'],
        });

        const normalized = normalizeSandboxConfig(parsed);

        expect(normalized.extraWritePaths).toEqual(['~/scratch']);
    });
});
