import { describe, expect, it } from 'vitest';
import {
    evaluateFileChangeSecurityPolicy,
    evaluateShellSecurityPolicy,
    extractFileChangePaths,
    isProtectedPolicyPath,
} from './policy';

describe('security policy', () => {
    describe('shell commands', () => {
        it('allows low-risk git read commands', () => {
            expect(evaluateShellSecurityPolicy({ command: 'git status --short' })).toMatchObject({
                decision: 'allow',
                category: 'git',
            });
        });

        it('asks before git push', () => {
            expect(evaluateShellSecurityPolicy({ command: 'git push origin HEAD:main' })).toMatchObject({
                decision: 'ask',
                risk: 'medium',
                category: 'git',
            });
        });

        it('unwraps shell -c command arrays before evaluating policy', () => {
            expect(evaluateShellSecurityPolicy({ command: ['/bin/zsh', '-lc', 'git push origin HEAD:main'] })).toMatchObject({
                decision: 'ask',
                risk: 'medium',
                category: 'git',
            });
        });

        it('treats force push as high risk', () => {
            expect(evaluateShellSecurityPolicy({ command: 'git push --force-with-lease' })).toMatchObject({
                decision: 'ask',
                risk: 'high',
                category: 'git',
            });
        });

        it('asks before destructive local git operations', () => {
            expect(evaluateShellSecurityPolicy({ command: 'git reset --hard HEAD~1' })).toMatchObject({
                decision: 'ask',
                risk: 'high',
                category: 'git',
            });
            expect(evaluateShellSecurityPolicy({ command: 'git clean -fd' })).toMatchObject({
                decision: 'ask',
                risk: 'high',
                category: 'git',
            });
        });

        it('asks before global git config changes', () => {
            expect(evaluateShellSecurityPolicy({ command: 'git config --global user.email test@example.com' })).toMatchObject({
                decision: 'ask',
                risk: 'high',
                category: 'git',
            });
        });

        it('allows read-only GitHub CLI operations', () => {
            expect(evaluateShellSecurityPolicy({ command: 'gh pr view 123' })).toMatchObject({
                decision: 'allow',
                category: 'github',
            });
        });

        it('denies GitHub token export', () => {
            expect(evaluateShellSecurityPolicy({ command: 'gh auth token' })).toMatchObject({
                decision: 'deny',
                risk: 'high',
                category: 'github',
            });
            expect(evaluateShellSecurityPolicy({ command: ['bash', '-lc', 'gh auth token'] })).toMatchObject({
                decision: 'deny',
                risk: 'high',
                category: 'github',
            });
        });

        it('asks before destructive GitHub CLI operations', () => {
            expect(evaluateShellSecurityPolicy({ command: 'gh pr merge 123 --squash' })).toMatchObject({
                decision: 'ask',
                risk: 'high',
                category: 'github',
            });
        });

        it('asks before package publishing', () => {
            expect(evaluateShellSecurityPolicy({ command: ['pnpm', 'publish', '--access', 'public'] })).toMatchObject({
                decision: 'ask',
                risk: 'high',
                category: 'package-publish',
            });
        });

        it('asks before complex commands involving protected tooling', () => {
            expect(evaluateShellSecurityPolicy({ command: 'git status && gh pr view 1' })).toMatchObject({
                decision: 'ask',
                category: 'shell',
            });
        });
    });

    describe('protected files', () => {
        it('classifies protected policy and workflow paths', () => {
            expect(isProtectedPolicyPath('.mcp.json')).toBe(true);
            expect(isProtectedPolicyPath('AGENTS.md')).toBe(true);
            expect(isProtectedPolicyPath('.claude/settings.json')).toBe(true);
            expect(isProtectedPolicyPath('.github/workflows/ci.yml')).toBe(true);
            expect(isProtectedPolicyPath('/tmp/project/subdir/AGENTS.md')).toBe(true);
            expect(isProtectedPolicyPath('/tmp/project/.github/workflows/ci.yml')).toBe(true);
            expect(isProtectedPolicyPath('src/index.ts')).toBe(false);
        });

        it('classifies env files without blocking examples', () => {
            expect(isProtectedPolicyPath('.env')).toBe(true);
            expect(isProtectedPolicyPath('.env.local')).toBe(true);
            expect(isProtectedPolicyPath('.env.example')).toBe(false);
        });

        it('extracts paths from known patch shapes', () => {
            expect(extractFileChangePaths({
                '.mcp.json': { add: true },
                one: { path: 'src/one.ts' },
                two: { filePath: '.github/workflows/ci.yml' },
            })).toEqual(expect.arrayContaining([
                '.mcp.json',
                'src/one.ts',
                '.github/workflows/ci.yml',
            ]));
        });

        it('asks before protected file changes', () => {
            expect(evaluateFileChangeSecurityPolicy({
                fileChanges: {
                    'src/index.ts': {},
                    '.codex/config.toml': {},
                },
            })).toMatchObject({
                decision: 'ask',
                risk: 'high',
                category: 'protected-file',
            });
        });

        it('allows ordinary file changes', () => {
            expect(evaluateFileChangeSecurityPolicy({
                fileChanges: {
                    'src/index.ts': {},
                },
            })).toMatchObject({
                decision: 'allow',
                category: 'protected-file',
            });
        });
    });
});
