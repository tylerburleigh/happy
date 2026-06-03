import { describe, expect, it } from 'vitest';

import { buildResumeLaunch, formatResumeHelp, parseResumeCommandArgs } from './handleResumeCommand';

describe('parseResumeCommandArgs', () => {
    it('parses the happy session id', () => {
        expect(parseResumeCommandArgs(['cmmij8olq00dp5jcxr3wtbpau'])).toEqual({
            showHelp: false,
            sessionId: 'cmmij8olq00dp5jcxr3wtbpau',
        });
    });

    it('recognizes help flags', () => {
        expect(parseResumeCommandArgs(['--help'])).toEqual({
            showHelp: true,
            sessionId: '',
        });
    });

    it('rejects missing session ids', () => {
        expect(() => parseResumeCommandArgs([])).toThrow(
            'Happy session ID is required: happy resume <session-id>',
        );
    });
});

describe('buildResumeLaunch', () => {
    it('builds a Codex resume command', () => {
        expect(buildResumeLaunch({
            id: 'session-1',
            active: false,
            metadata: {
                path: '/tmp/p1-control-flow',
                flavor: 'codex',
                codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toEqual({
            cwd: '/tmp/p1-control-flow',
            args: ['codex', '--resume', '019ccca5-726b-7c61-b914-16de27dfab6e'],
            env: undefined,
        });
    });

    it('builds a Claude resume command', () => {
        expect(buildResumeLaunch({
            id: 'session-2',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'claude',
                claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toEqual({
            cwd: '/tmp/repo',
            args: ['claude', '--resume', '93a9705e-bc6a-406d-8dce-8acc014dedbd'],
            env: undefined,
        });
    });

    it('builds resume env for sandboxed provider state', () => {
        expect(buildResumeLaunch({
            id: 'session-4',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'claude',
                claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
                sandboxState: {
                    root: '/tmp/.happy/tmp/sandbox-state/claude/session-4',
                    claudeConfigDir: '/tmp/.happy/tmp/sandbox-state/claude/session-4/claude',
                },
            },
        })).toEqual({
            cwd: '/tmp/repo',
            args: ['claude', '--resume', '93a9705e-bc6a-406d-8dce-8acc014dedbd'],
            env: {
                CLAUDE_CONFIG_DIR: '/tmp/.happy/tmp/sandbox-state/claude/session-4/claude',
            },
        });
    });

    it('rejects sandboxed provider state outside the saved sandbox root', () => {
        expect(() => buildResumeLaunch({
            id: 'session-5',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'claude',
                claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
                sandboxState: {
                    root: '/tmp/.happy/tmp/sandbox-state/claude/session-5',
                    claudeConfigDir: '/tmp/.ssh',
                },
            },
        })).toThrow(/provider path does not match its root/);
    });

    it('rejects sandboxed provider state roots outside the recorded Happy home', () => {
        expect(() => buildResumeLaunch({
            id: 'session-6',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'codex',
                codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
                sandboxState: {
                    root: '/tmp/other/tmp/sandbox-state/codex/session-6',
                    codexHome: '/tmp/other/tmp/sandbox-state/codex/session-6/codex',
                },
            },
        })).toThrow(/outside the recorded Happy sandbox-state directory/);
    });

    it('rejects malformed sandboxed provider state paths', () => {
        expect(() => buildResumeLaunch({
            id: 'session-7',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'claude',
                claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
                sandboxState: {
                    root: '/tmp/.happy/tmp/sandbox-state/claude/session-7',
                    claudeConfigDir: '/tmp/.happy/tmp/sandbox-state/claude/session-7/claude\u0007',
                },
            },
        })).toThrow(/contains control characters/);
    });

    it('rejects flag-shaped Codex resume thread IDs from metadata', () => {
        expect(() => buildResumeLaunch({
            id: 'session-8',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'codex',
                codexThreadId: '--permission-mode',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toThrow(/Codex thread ID must not look like a command-line flag/);
    });

    it('rejects whitespace-bearing Claude resume session IDs from metadata', () => {
        expect(() => buildResumeLaunch({
            id: 'session-9',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'claude',
                claudeSessionId: '93a9705e bc6a',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toThrow(/Claude session ID contains whitespace or control characters/);
    });

    it('rejects unsupported flavors', () => {
        expect(() => buildResumeLaunch({
            id: 'session-3',
            active: false,
            metadata: {
                path: '/tmp/repo',
                flavor: 'gemini',
                host: 'localhost',
                homeDir: '/tmp',
                happyHomeDir: '/tmp/.happy',
                happyLibDir: '/tmp/happy',
                happyToolsDir: '/tmp/happy/tools',
            },
        })).toThrow('Happy session session-3 uses unsupported flavor "gemini".');
    });
});

describe('formatResumeHelp', () => {
    it('mentions the session id command shape', () => {
        expect(formatResumeHelp()).toContain('happy resume <happy-session-id>');
    });
});
