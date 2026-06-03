import { delimiter, isAbsolute } from 'node:path';
import type { SandboxConfig } from '@/persistence';
import { logger } from '@/ui/logger';
import { getSandboxAgentHomePaths } from './config';

const SAFE_PARENT_ENV_KEYS = new Set([
    'CI',
    'COLORTERM',
    'FORCE_COLOR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LOGNAME',
    'NO_COLOR',
    'PATH',
    'Path',
    'RUST_BACKTRACE',
    'RUST_LOG',
    'SHELL',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE',
    'TERM',
    'TERM_PROGRAM',
    'USER',
    'NODE_EXTRA_CA_CERTS',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
]);

const SAFE_PARENT_HAPPY_ENV_KEYS = new Set([
    'HAPPY_DISABLE_CAFFEINATE',
    'HAPPY_EXPERIMENTAL',
    'HAPPY_HTTP_MCP_URL',
    'HAPPY_PROJECT_ROOT',
    'HAPPY_SERVER_URL',
    'HAPPY_VARIANT',
    'HAPPY_WEBAPP_URL',
]);

const BLOCKED_SANDBOX_ENV_KEYS = new Set([
    'BASH_ENV',
    'ENV',
    'GEM_HOME',
    'GEM_PATH',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_ASKPASS',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_SYSTEM',
    'GIT_DIR',
    'GIT_EDITOR',
    'GIT_EXEC_PATH',
    'GIT_EXTERNAL_DIFF',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_PAGER',
    'GIT_SEQUENCE_EDITOR',
    'GIT_SSH',
    'GIT_SSH_COMMAND',
    'GIT_TEMPLATE_DIR',
    'GIT_WORK_TREE',
    'GPG_AGENT_INFO',
    'HAPPY_HOME_DIR',
    'HAPPY_INJECT_HTML_CONFIG',
    'HAPPY_PROJECT_DIR',
    'HAPPY_RUN_SANDBOX_NETWORK_TESTS',
    'HAPPY_STATIC_DIR',
    'NODE_OPTIONS',
    'NODE_PATH',
    'PERL5LIB',
    'PERL5OPT',
    'PROMPT_COMMAND',
    'PYTHONHOME',
    'PYTHONPATH',
    'RUBYLIB',
    'RUBYOPT',
    'SSH_ASKPASS',
    'SSH_AUTH_SOCK',
    'ZDOTDIR',
]);

const SAFE_SHELL_PATHS = new Set([
    '/bin/bash',
    '/bin/fish',
    '/bin/sh',
    '/bin/zsh',
    '/usr/bin/bash',
    '/usr/bin/fish',
    '/usr/bin/sh',
    '/usr/bin/zsh',
]);

type EnvInput = Record<string, string | undefined>;

function isWellFormedEnvKey(key: string): boolean {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key);
}

function isBlockedSandboxEnvKey(key: string): boolean {
    return BLOCKED_SANDBOX_ENV_KEYS.has(key)
        || key.startsWith('GIT_CONFIG_KEY_')
        || key.startsWith('GIT_CONFIG_VALUE_')
        || key.startsWith('HAPPY_DAEMON_')
        || key.startsWith('HAPPY_FORK_')
        || key.startsWith('HAPPY_FORKED_')
        || key.startsWith('HAPPY_RECONNECT_')
        || key.startsWith('DYLD_')
        || key.startsWith('LD_');
}

function sanitizePathEnvValue(value: string): string | undefined {
    const safeSegments = value
        .split(delimiter)
        .filter((segment) => segment.trim().length > 0)
        .filter((segment) => segment === segment.trim())
        .filter((segment) => segment !== '.')
        .filter((segment) => isAbsolute(segment));
    const uniqueSegments = [...new Set(safeSegments)];

    return uniqueSegments.length > 0 ? uniqueSegments.join(delimiter) : undefined;
}

function sanitizeIdentityEnvValue(value: string): string | undefined {
    return /^[a-zA-Z0-9._-]{1,128}$/.test(value) ? value : undefined;
}

function normalizeEnvValue(key: string, value: string): string | undefined {
    if (/[\u0000-\u001f\u007f]/.test(value)) {
        return undefined;
    }

    if (key === 'PATH' || key === 'Path') {
        return sanitizePathEnvValue(value);
    }

    if (key === 'USER' || key === 'LOGNAME') {
        return sanitizeIdentityEnvValue(value);
    }

    if (key === 'SHELL') {
        if (SAFE_SHELL_PATHS.has(value)) {
            return value;
        }

        return process.platform === 'win32' ? undefined : '/bin/sh';
    }

    return value;
}

function copyStringEnvValue(target: Record<string, string>, key: string, value: string | undefined): void {
    if (typeof value === 'string') {
        if (!isWellFormedEnvKey(key)) {
            delete target[key];
            return;
        }

        if (isBlockedSandboxEnvKey(key)) {
            delete target[key];
            return;
        }

        const normalized = normalizeEnvValue(key, value);
        if (normalized === undefined) {
            delete target[key];
            return;
        }

        target[key] = normalized;
    }
}

function isSafeParentEnvKey(key: string, extraSafeKeys: ReadonlySet<string>): boolean {
    return SAFE_PARENT_ENV_KEYS.has(key) || SAFE_PARENT_HAPPY_ENV_KEYS.has(key) || extraSafeKeys.has(key);
}

export function buildSandboxedProcessEnv(
    parentEnv?: EnvInput,
    explicitEnv?: EnvInput,
): Record<string, string>;
export function buildSandboxedProcessEnv(
    parentEnv: EnvInput,
    sandboxConfig: SandboxConfig,
    sessionPath: string,
    explicitEnv?: EnvInput,
): Record<string, string>;
export function buildSandboxedProcessEnv(
    parentEnv: EnvInput = process.env,
    explicitEnvOrConfig: EnvInput | SandboxConfig = {},
    sessionPath?: string,
    legacyExplicitEnv: EnvInput = {},
): Record<string, string> {
    const env: Record<string, string> = {};
    let explicitEnv: EnvInput;
    let extraSafeParentKeys: ReadonlySet<string> = new Set();

    if (isSandboxConfig(explicitEnvOrConfig)) {
        if (!sessionPath) {
            throw new Error('Sandbox session path is required when building env from sandbox config');
        }

        const { codexHome, claudeConfigDir } = getSandboxAgentHomePaths(explicitEnvOrConfig, sessionPath);
        if (explicitEnvOrConfig.agentHomeMode === 'shared') {
            logger.warn(
                '[sandbox/env] agentHomeMode=shared exposes existing Claude/Codex config and state to sandboxed agents. Prefer isolated unless intentionally debugging.',
            );
        }

        extraSafeParentKeys = new Set(explicitEnvOrConfig.envPassthrough);
        explicitEnv = {
            ...legacyExplicitEnv,
            CODEX_HOME: codexHome,
            CLAUDE_CONFIG_DIR: claudeConfigDir,
        };
    } else {
        explicitEnv = explicitEnvOrConfig;
    }

    for (const [key, value] of Object.entries(parentEnv)) {
        if (isSafeParentEnvKey(key, extraSafeParentKeys)) {
            copyStringEnvValue(env, key, value);
        }
    }

    // Launch-specific env is intentionally authoritative: callers use it for
    // auth tokens, model settings, reconnect metadata, and other explicit policy.
    for (const [key, value] of Object.entries(explicitEnv)) {
        copyStringEnvValue(env, key, value);
    }

    return env;
}

function isSandboxConfig(value: EnvInput | SandboxConfig): value is SandboxConfig {
    return value !== null
        && typeof value === 'object'
        && 'sessionIsolation' in value
        && 'networkMode' in value
        && 'denyReadPaths' in value;
}
