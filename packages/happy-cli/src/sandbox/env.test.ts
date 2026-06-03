import { describe, expect, it } from 'vitest';
import { delimiter } from 'node:path';
import { buildSandboxedProcessEnv } from './env';

describe('buildSandboxedProcessEnv', () => {
    it('keeps safe runtime env and drops ambient secrets', () => {
        const env = buildSandboxedProcessEnv({
            PATH: '/usr/bin',
            PWD: '/outside/workspace',
            HOME: '/home/test',
            HAPPY_HOME_DIR: '/home/test/.happy',
            CODEX_HOME: '/home/test/.codex',
            CLAUDE_CONFIG_DIR: '/home/test/.claude',
            HAPPY_RECONNECT_ENCRYPTION_KEY: 'secret-reconnect-key',
            AWS_SECRET_ACCESS_KEY: 'ambient-aws-secret',
            ANTHROPIC_AUTH_TOKEN: 'ambient-anthropic-token',
            TMPDIR: '/private/var/folders/user-temp',
            TMP: '/tmp/from-parent',
            TEMP: '/tmp/from-parent',
            XDG_CONFIG_HOME: '/home/test/.config',
        });

        expect(env).toEqual({
            PATH: '/usr/bin',
        });
    });

    it('lets launch-specific env override and include credentials explicitly', () => {
        const env = buildSandboxedProcessEnv(
            {
                PATH: '/usr/bin',
                ANTHROPIC_AUTH_TOKEN: 'ambient-token',
                OPENAI_API_KEY: 'ambient-openai-key',
            },
            {
                ANTHROPIC_AUTH_TOKEN: 'explicit-token',
                OPENAI_API_KEY: 'explicit-openai-key',
                CODEX_HOME: '/workspace/.happy/codex',
                CLAUDE_CONFIG_DIR: '/workspace/.happy/claude',
                HOME: '/workspace/.happy/home',
                TMPDIR: '/workspace/.happy/tmp',
            },
        );

        expect(env).toEqual({
            PATH: '/usr/bin',
            ANTHROPIC_AUTH_TOKEN: 'explicit-token',
            OPENAI_API_KEY: 'explicit-openai-key',
            CODEX_HOME: '/workspace/.happy/codex',
            CLAUDE_CONFIG_DIR: '/workspace/.happy/claude',
            HOME: '/workspace/.happy/home',
            TMPDIR: '/workspace/.happy/tmp',
        });
    });

    it('skips undefined values', () => {
        const env = buildSandboxedProcessEnv(
            {
                PATH: undefined,
                HOME: '/home/test',
            },
            {
                ANTHROPIC_AUTH_TOKEN: undefined,
            },
        );

        expect(env).toEqual({});
    });

    it('removes empty and relative PATH entries from parent and explicit env', () => {
        const env = buildSandboxedProcessEnv(
            {
                PATH: ['/usr/bin', '', '.', 'relative/bin', '/bin ', '/bin', '/usr/bin'].join(delimiter),
            },
            {
                PATH: ['.', '/opt/bin', 'tools/bin', ' /padded/bin', '/custom/bin', '/opt/bin'].join(delimiter),
            },
        );

        expect(env.PATH).toBe(['/opt/bin', '/custom/bin'].join(delimiter));
    });

    it('removes PATH entirely when no absolute entries remain', () => {
        const env = buildSandboxedProcessEnv(
            {
                PATH: '/usr/bin',
            },
            {
                PATH: ['', '.', 'relative/bin'].join(delimiter),
            },
        );

        expect(env.PATH).toBeUndefined();
    });

    it('drops loader and shell hook env even when provided explicitly', () => {
        const env = buildSandboxedProcessEnv(
            {
                LD_PRELOAD: '/tmp/parent-preload.so',
                DYLD_INSERT_LIBRARIES: '/tmp/parent-dyld.dylib',
                BASH_ENV: '/tmp/parent-bash-env',
            },
            {
                LD_LIBRARY_PATH: '/tmp/libs',
                DYLD_FALLBACK_LIBRARY_PATH: '/tmp/dyld',
                NODE_OPTIONS: '--require /tmp/hook.js',
                PYTHONPATH: '/tmp/python',
                GIT_SSH_COMMAND: 'ssh -i /tmp/key',
                SSH_AUTH_SOCK: '/tmp/agent.sock',
                ZDOTDIR: '/tmp/zsh',
            },
        );

        expect(env).toEqual({});
    });

    it('drops Git config and execution injection env while keeping managed Git config env', () => {
        const env = buildSandboxedProcessEnv(
            {
                GIT_DIR: '/outside/.git',
                GIT_CONFIG_PARAMETERS: "'include.path=/outside/config'",
            },
            {
                GIT_CONFIG_COUNT: '1',
                GIT_CONFIG_KEY_0: 'include.path',
                GIT_CONFIG_VALUE_0: '/outside/config',
                GIT_EXEC_PATH: '/outside/git-core',
                GIT_EXTERNAL_DIFF: '/outside/diff',
                GIT_WORK_TREE: '/outside/worktree',
                GIT_CONFIG_GLOBAL: '/sandbox-home/.gitconfig',
                GIT_CONFIG_NOSYSTEM: '1',
            },
        );

        expect(env).toEqual({
            GIT_CONFIG_GLOBAL: '/sandbox-home/.gitconfig',
            GIT_CONFIG_NOSYSTEM: '1',
        });
    });

    it('drops sensitive Happy control env while keeping public Happy routing env', () => {
        const env = buildSandboxedProcessEnv(
            {
                HAPPY_SERVER_URL: 'https://api.example.test',
                HAPPY_WEBAPP_URL: 'https://app.example.test',
                HAPPY_HOME_DIR: '/outside/.happy',
                HAPPY_RECONNECT_ENCRYPTION_KEY: 'secret',
            },
            {
                HAPPY_DAEMON_HTTP_TIMEOUT: '1',
                HAPPY_FORKED_FROM_SESSION_ID: 'session-1',
                HAPPY_FORK_CLAUDE_SESSION_ID: 'claude-1',
                HAPPY_INJECT_HTML_CONFIG: '{"secret":true}',
                HAPPY_STATIC_DIR: '/outside/static',
                HAPPY_VARIANT: 'dev',
            },
        );

        expect(env).toEqual({
            HAPPY_SERVER_URL: 'https://api.example.test',
            HAPPY_WEBAPP_URL: 'https://app.example.test',
            HAPPY_VARIANT: 'dev',
        });
    });

    it('keeps known system shells and replaces unsafe shell paths', () => {
        const safeEnv = buildSandboxedProcessEnv({
            SHELL: '/bin/zsh',
        });
        const unsafeParentEnv = buildSandboxedProcessEnv({
            SHELL: '/workspace/bin/sh',
        });
        const unsafeExplicitEnv = buildSandboxedProcessEnv(
            {
                SHELL: '/bin/zsh',
            },
            {
                SHELL: './workspace-shell',
            },
        );

        expect(safeEnv.SHELL).toBe('/bin/zsh');
        if (process.platform === 'win32') {
            expect(unsafeParentEnv.SHELL).toBeUndefined();
            expect(unsafeExplicitEnv.SHELL).toBeUndefined();
        } else {
            expect(unsafeParentEnv.SHELL).toBe('/bin/sh');
            expect(unsafeExplicitEnv.SHELL).toBe('/bin/sh');
        }
    });

    it('drops unsafe USER and LOGNAME values', () => {
        const env = buildSandboxedProcessEnv({
            USER: 'valid-user_1',
            LOGNAME: 'bad\nlogname',
        }, {
            USER: 'bad user',
        });

        expect(env.USER).toBeUndefined();
        expect(env.LOGNAME).toBeUndefined();

        const safeEnv = buildSandboxedProcessEnv({
            USER: 'valid-user_1',
            LOGNAME: 'valid.logname',
        });

        expect(safeEnv.USER).toBe('valid-user_1');
        expect(safeEnv.LOGNAME).toBe('valid.logname');
    });

    it('drops malformed env keys from parent and explicit env', () => {
        const env = buildSandboxedProcessEnv(
            {
                GOOD_KEY: 'parent-ok',
                'BAD-KEY': 'parent-bad',
                'BAD\nKEY': 'parent-bad',
                '1BAD': 'parent-bad',
            },
            {
                EXPLICIT_KEY: 'explicit-ok',
                'ALSO=BAD': 'explicit-bad',
            },
        );

        expect(env.GOOD_KEY).toBeUndefined();
        expect(env.EXPLICIT_KEY).toBe('explicit-ok');
        expect(env['BAD-KEY']).toBeUndefined();
        expect(env['BAD\nKEY']).toBeUndefined();
        expect(env['1BAD']).toBeUndefined();
        expect(env['ALSO=BAD']).toBeUndefined();
    });

    it('drops env values with control characters', () => {
        const env = buildSandboxedProcessEnv(
            {
                PATH: '/usr/bin',
            },
            {
                ANTHROPIC_AUTH_TOKEN: 'token\nwith-newline',
                OPENAI_API_KEY: 'clean-token',
            },
        );

        expect(env.PATH).toBe('/usr/bin');
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(env.OPENAI_API_KEY).toBe('clean-token');
    });
});
