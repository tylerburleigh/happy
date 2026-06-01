import { delimiter, join } from 'node:path';
import { chmodSync } from 'node:fs';
import type { SandboxConfig } from '@/persistence';
import { configuration } from '@/configuration';
import { ensurePrivateDirSync, writePrivateFileSync } from '@/utils/privateFiles';
import { getSandboxAgentHomePaths } from './config';

const SAFE_BASE_ENV = new Set([
    'COLORTERM',
    'HOME',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LOGNAME',
    'PATH',
    'SHELL',
    'TERM',
    'TMPDIR',
    'USER',
]);

const SAFE_HAPPY_ENV = new Set([
    'HAPPY_HOME_DIR',
    'HAPPY_SERVER_URL',
    'HAPPY_WEBAPP_URL',
    'HAPPY_VARIANT',
    'HAPPY_EXPERIMENTAL',
    'HAPPY_DISABLE_CAFFEINATE',
    'HAPPY_FORKED_FROM_SESSION_ID',
    'HAPPY_FORKED_FROM_MESSAGE_ID',
    'HAPPY_FORK_CLAUDE_SESSION_ID',
    'HAPPY_RECONNECT_SESSION_ID',
    'HAPPY_RECONNECT_ENCRYPTION_KEY',
    'HAPPY_RECONNECT_ENCRYPTION_VARIANT',
    'HAPPY_RECONNECT_SEQ',
    'HAPPY_RECONNECT_METADATA_VERSION',
    'HAPPY_RECONNECT_AGENT_STATE_VERSION',
]);

const GUARDED_COMMANDS = [
    'security',
    'gh',
    'gcloud',
    'aws',
    'kubectl',
    'docker',
    'op',
    'ksm',
    'ssh-add',
    'pbpaste',
    'secret-tool',
    'pass',
    'gopass',
    'kwallet-query',
    'keyctl',
    'xclip',
    'xsel',
    'wl-paste',
];

function shouldPassEnv(key: string, sandboxConfig: SandboxConfig): boolean {
    if (SAFE_BASE_ENV.has(key) || SAFE_HAPPY_ENV.has(key)) return true;
    return sandboxConfig.envPassthrough.includes(key);
}

export function buildSandboxedProcessEnv(
    baseEnv: NodeJS.ProcessEnv,
    sandboxConfig: SandboxConfig,
    sessionPath: string,
    explicitEnv: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(baseEnv)) {
        if (typeof value === 'string' && shouldPassEnv(key, sandboxConfig)) {
            env[key] = value;
        }
    }

    for (const [key, value] of Object.entries(explicitEnv)) {
        if (typeof value === 'string') {
            env[key] = value;
        }
    }

    const { codexHome, claudeConfigDir } = getSandboxAgentHomePaths(sandboxConfig, sessionPath);
    ensurePrivateDirSync(codexHome);
    ensurePrivateDirSync(claudeConfigDir);

    env.CODEX_HOME = codexHome;
    env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    const guardBinDir = ensureSandboxGuardBin();
    env.PATH = [guardBinDir, env.PATH || process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].join(delimiter);

    return env;
}

function ensureSandboxGuardBin(): string {
    const guardBinDir = join(configuration.happyHomeDir, 'sandbox-bin');
    ensurePrivateDirSync(guardBinDir);

    for (const command of GUARDED_COMMANDS) {
        const guardPath = join(guardBinDir, command);
        writePrivateFileSync(guardPath, guardScript(command));
        try {
            chmodSync(guardPath, 0o700);
        } catch { }
    }

    return guardBinDir;
}

function guardScript(command: string): string {
    return [
        '#!/bin/sh',
        `echo "Blocked by Happy sandbox guard: ${command} is not available inside sandboxed agent sessions." >&2`,
        'exit 126',
        '',
    ].join('\n');
}
