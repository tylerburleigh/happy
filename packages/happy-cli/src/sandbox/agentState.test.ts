import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const mocks = vi.hoisted(() => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');

    return {
        happyHomeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'happy-agent-state-home-')),
    };
});

vi.mock('@/configuration', () => ({
    configuration: {
        get happyHomeDir() {
            return mocks.happyHomeDir;
        },
    },
}));

import { createSandboxAgentState } from './agentState';

function expectedDenyReadPaths(path: string): string[] {
    return Array.from(new Set([path, realpathSync(path)]));
}

describe('createSandboxAgentState', () => {
    let sourceDir: string;
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const originalCodexHome = process.env.CODEX_HOME;

    beforeEach(() => {
        sourceDir = mkdtempSync(join(tmpdir(), 'provider-state-'));
    });

    afterEach(() => {
        rmSync(sourceDir, { recursive: true, force: true });
        rmSync(mocks.happyHomeDir, { recursive: true, force: true });
        mocks.happyHomeDir = mkdtempSync(join(tmpdir(), 'happy-agent-state-home-'));

        if (originalClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        } else {
            process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
        }

        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = originalCodexHome;
        }
    });

    it('copies Claude bootstrap state while excluding project history', async () => {
        process.env.CLAUDE_CONFIG_DIR = sourceDir;
        writeFileSync(join(sourceDir, 'settings.json'), '{"ok":true}');
        mkdirSync(join(sourceDir, 'projects'));
        writeFileSync(join(sourceDir, 'projects', 'old.jsonl'), '{}');

        const state = await createSandboxAgentState('claude', 'session-1');

        expect(state.env.CLAUDE_CONFIG_DIR).toBe(join(state.root, 'claude'));
        expect(readFileSync(join(state.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf-8')).toBe('{"ok":true}');
        expect(existsSync(join(state.env.CLAUDE_CONFIG_DIR, 'projects'))).toBe(false);
        expect(state.runtimeOptions).toEqual({
            agentStatePaths: [state.root, state.env.CLAUDE_CONFIG_DIR],
            denyReadPaths: expectedDenyReadPaths(sourceDir),
            includeSharedAgentStatePaths: false,
        });
    });

    it('copies only regular provider state files with private permissions', async () => {
        process.env.CLAUDE_CONFIG_DIR = sourceDir;
        mkdirSync(join(sourceDir, 'nested'));
        writeFileSync(join(sourceDir, 'settings.json'), '{"ok":true}', { mode: 0o644 });
        writeFileSync(join(sourceDir, 'nested', 'config.json'), '{"nested":true}', { mode: 0o644 });

        if (process.platform !== 'win32') {
            symlinkSync(join(sourceDir, 'settings.json'), join(sourceDir, 'settings-link.json'));
            symlinkSync(join(sourceDir, 'settings.json'), join(sourceDir, 'nested', 'nested-link.json'));
        }

        const state = await createSandboxAgentState('claude', 'session-1');

        expect(readFileSync(join(state.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf-8')).toBe('{"ok":true}');
        expect(readFileSync(join(state.env.CLAUDE_CONFIG_DIR, 'nested', 'config.json'), 'utf-8')).toBe('{"nested":true}');
        expect(existsSync(join(state.env.CLAUDE_CONFIG_DIR, 'settings-link.json'))).toBe(false);
        expect(existsSync(join(state.env.CLAUDE_CONFIG_DIR, 'nested', 'nested-link.json'))).toBe(false);

        if (process.platform !== 'win32') {
            expect(statSync(state.root).mode & 0o777).toBe(0o700);
            expect(statSync(state.env.CLAUDE_CONFIG_DIR).mode & 0o777).toBe(0o700);
            expect(statSync(join(state.env.CLAUDE_CONFIG_DIR, 'nested')).mode & 0o777).toBe(0o700);
            expect(statSync(join(state.env.CLAUDE_CONFIG_DIR, 'settings.json')).mode & 0o777).toBe(0o600);
            expect(statSync(join(state.env.CLAUDE_CONFIG_DIR, 'nested', 'config.json')).mode & 0o777).toBe(0o600);
        }
    });

    it('copies Codex auth state while excluding session history', async () => {
        process.env.CODEX_HOME = sourceDir;
        writeFileSync(join(sourceDir, 'auth.json'), '{"token":"token"}');
        mkdirSync(join(sourceDir, 'sessions'));
        writeFileSync(join(sourceDir, 'sessions', 'old.jsonl'), '{}');

        const state = await createSandboxAgentState('codex', 'session-1');

        expect(state.env.CODEX_HOME).toBe(join(state.root, 'codex'));
        expect(readFileSync(join(state.env.CODEX_HOME, 'auth.json'), 'utf-8')).toBe('{"token":"token"}');
        expect(existsSync(join(state.env.CODEX_HOME, 'sessions'))).toBe(false);
        expect(state.runtimeOptions).toEqual({
            agentStatePaths: [state.root, state.env.CODEX_HOME],
            denyReadPaths: expectedDenyReadPaths(sourceDir),
            includeSharedAgentStatePaths: false,
        });
    });

    it('normalizes relative provider source paths before denying read access', async () => {
        const relativeSource = relative(process.cwd(), sourceDir);
        writeFileSync(join(sourceDir, 'auth.json'), '{"token":"token"}');
        process.env.CODEX_HOME = relativeSource;

        const state = await createSandboxAgentState('codex', 'session-1');

        expect(readFileSync(join(state.env.CODEX_HOME, 'auth.json'), 'utf-8')).toBe('{"token":"token"}');
        expect(state.runtimeOptions.denyReadPaths).toContain(resolve(relativeSource));
    });

    it('does not copy symlinked provider source directories and denies the real target', async () => {
        if (process.platform === 'win32') {
            return;
        }

        const symlinkDir = join(tmpdir(), `provider-state-link-${Date.now()}`);

        try {
            writeFileSync(join(sourceDir, 'auth.json'), '{"token":"token"}');
            symlinkSync(sourceDir, symlinkDir, 'dir');
            process.env.CODEX_HOME = symlinkDir;

            const state = await createSandboxAgentState('codex', 'session-1');

            expect(existsSync(join(state.env.CODEX_HOME, 'auth.json'))).toBe(false);
            expect(state.runtimeOptions.denyReadPaths).toEqual([
                resolve(symlinkDir),
                realpathSync(sourceDir),
            ]);
        } finally {
            rmSync(symlinkDir, { recursive: true, force: true });
        }
    });

    it('rejects preexisting session state roots instead of reusing stale state', async () => {
        process.env.CODEX_HOME = sourceDir;
        mkdirSync(join(mocks.happyHomeDir, 'tmp', 'sandbox-state', 'codex', 'session-1'), { recursive: true });

        await expect(createSandboxAgentState('codex', 'session-1')).rejects.toThrow(
            /session state root already exists and will not be reused/,
        );
    });

    it('rejects symlinked sandbox state parent directories', async () => {
        if (process.platform === 'win32') {
            return;
        }

        const targetDir = mkdtempSync(join(tmpdir(), 'sandbox-state-target-'));

        try {
            process.env.CODEX_HOME = sourceDir;
            writeFileSync(join(sourceDir, 'auth.json'), '{"token":"token"}');
            mkdirSync(join(mocks.happyHomeDir, 'tmp'), { recursive: true });
            symlinkSync(targetDir, join(mocks.happyHomeDir, 'tmp', 'sandbox-state'), 'dir');

            await expect(createSandboxAgentState('codex', 'session-1')).rejects.toThrow(
                /sandbox state root must be a directory and may not be a symbolic link/,
            );
            expect(existsSync(join(targetDir, 'codex', 'session-1', 'codex', 'auth.json'))).toBe(false);
        } finally {
            rmSync(targetDir, { recursive: true, force: true });
        }
    });
});
