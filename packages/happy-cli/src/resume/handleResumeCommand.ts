import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { Metadata } from '@/api/types';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

import { resolveHappySession, type ResumableHappySession } from './resolveHappySession';

export type ResumeLaunch = {
    cwd: string;
    args: string[];
    env?: Record<string, string>;
};

export type ResumeLaunchOptions = {
    claudeStartingMode?: 'local' | 'remote';
    startedBy?: 'daemon' | 'terminal';
};

export function parseResumeCommandArgs(args: string[]): { showHelp: boolean; sessionId: string } {
    if (args.includes('-h') || args.includes('--help')) {
        return {
            showHelp: true,
            sessionId: '',
        };
    }

    if (args.length === 0) {
        throw new Error('Happy session ID is required: happy resume <session-id>');
    }
    if (args.length > 1) {
        throw new Error(`Unexpected arguments for happy resume: ${args.slice(1).join(' ')}`);
    }

    return {
        showHelp: false,
        sessionId: args[0],
    };
}

function resolveFlavor(metadata: Metadata): 'codex' | 'claude' | null {
    if (metadata.flavor === 'codex' || metadata.codexThreadId) {
        return 'codex';
    }
    if (metadata.flavor === 'claude' || metadata.claudeSessionId) {
        return 'claude';
    }
    return null;
}

function assertWellFormedSandboxStatePath(pathValue: string, label: string): string {
    if (pathValue.trim().length === 0 || pathValue !== pathValue.trim()) {
        throw new Error(`Saved sandbox state ${label} is empty or whitespace-padded.`);
    }

    if (/[\u0000-\u001f\u007f]/.test(pathValue)) {
        throw new Error(`Saved sandbox state ${label} contains control characters.`);
    }

    if (!isAbsolute(pathValue)) {
        throw new Error(`Saved sandbox state ${label} must be an absolute path.`);
    }

    if (pathValue.split(/[\\/]+/).includes('..')) {
        throw new Error(`Saved sandbox state ${label} may not contain parent directory traversal.`);
    }

    return resolve(pathValue);
}

function isPathInside(parent: string, child: string): boolean {
    const relativePath = relative(parent, child);
    return relativePath === '' || (relativePath.length > 0 && !relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function assertWellFormedResumeIdentifier(value: string, label: string): string {
    if (value.trim().length === 0 || value !== value.trim()) {
        throw new Error(`Saved ${label} is empty or whitespace-padded.`);
    }

    if (value.length > 256) {
        throw new Error(`Saved ${label} is too long.`);
    }

    if (/[\s\u0000-\u001f\u007f]/.test(value)) {
        throw new Error(`Saved ${label} contains whitespace or control characters.`);
    }

    if (value.startsWith('-')) {
        throw new Error(`Saved ${label} must not look like a command-line flag.`);
    }

    return value;
}

function validateSandboxProviderStatePath(metadata: Metadata, providerPath: string, providerName: 'claude' | 'codex'): string {
    if (!metadata.sandboxState?.root) {
        throw new Error(`Saved sandbox state for ${providerName} is missing its root path.`);
    }

    const happyHomeDir = assertWellFormedSandboxStatePath(metadata.happyHomeDir, 'Happy home path');
    const sandboxStateRoot = assertWellFormedSandboxStatePath(metadata.sandboxState.root, 'root path');
    const sandboxStateBase = join(happyHomeDir, 'tmp', 'sandbox-state');
    if (!isPathInside(sandboxStateBase, sandboxStateRoot)) {
        throw new Error(`Saved sandbox state root is outside the recorded Happy sandbox-state directory.`);
    }

    const resolvedProviderPath = assertWellFormedSandboxStatePath(providerPath, `${providerName} provider path`);
    const expectedProviderPath = join(sandboxStateRoot, providerName);
    if (resolvedProviderPath !== expectedProviderPath) {
        throw new Error(`Saved sandbox state ${providerName} provider path does not match its root.`);
    }

    return resolvedProviderPath;
}

function buildSandboxStateEnv(metadata: Metadata): Record<string, string> | undefined {
    const env: Record<string, string> = {};
    if (metadata.sandboxState?.claudeConfigDir) {
        env.CLAUDE_CONFIG_DIR = validateSandboxProviderStatePath(
            metadata,
            metadata.sandboxState.claudeConfigDir,
            'claude',
        );
    }
    if (metadata.sandboxState?.codexHome) {
        env.CODEX_HOME = validateSandboxProviderStatePath(
            metadata,
            metadata.sandboxState.codexHome,
            'codex',
        );
    }
    return Object.keys(env).length > 0 ? env : undefined;
}

export function buildResumeLaunch(session: ResumableHappySession, options: ResumeLaunchOptions = {}): ResumeLaunch {
    const { metadata } = session;
    const flavor = resolveFlavor(metadata);

    if (flavor === 'codex') {
        if (!metadata.codexThreadId) {
            throw new Error(`Happy session ${session.id} is missing its Codex thread ID.`);
        }
        const codexThreadId = assertWellFormedResumeIdentifier(metadata.codexThreadId, 'Codex thread ID');
        const args = ['codex', '--resume', codexThreadId];
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        return {
            cwd: metadata.path,
            args,
            env: buildSandboxStateEnv(metadata),
        };
    }

    if (flavor === 'claude') {
        if (!metadata.claudeSessionId) {
            throw new Error(`Happy session ${session.id} is missing its Claude session ID.`);
        }
        const claudeSessionId = assertWellFormedResumeIdentifier(metadata.claudeSessionId, 'Claude session ID');
        const args = ['claude'];
        if (options.claudeStartingMode) {
            args.push('--happy-starting-mode', options.claudeStartingMode);
        }
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        args.push('--resume', claudeSessionId);
        return {
            cwd: metadata.path,
            args,
            env: buildSandboxStateEnv(metadata),
        };
    }

    throw new Error(`Happy session ${session.id} uses unsupported flavor "${metadata.flavor ?? 'unknown'}".`);
}

export function formatResumeHelp(): string {
    return [
        'happy resume - Resume a previous Happy session',
        '',
        'Usage:',
        '  happy resume <happy-session-id>',
        '',
        'Examples:',
        '  happy resume cmmij8olq00dp5jcxr3wtbpau',
        '  happy resume cmmij8',
        '',
        'This reuses the saved worktree/path and resumes the underlying agent session',
        'when the backend supports it.',
    ].join('\n');
}

function spawnResumeChild(launch: ResumeLaunch): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawnHappyCLI(launch.args, {
            cwd: launch.cwd,
            env: {
                ...process.env,
                ...launch.env,
            },
            stdio: 'inherit',
        });

        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`Resumed session exited via signal ${signal}`));
                return;
            }
            resolve(code);
        });
    });
}

export async function handleResumeCommand(args: string[]): Promise<void> {
    const parsed = parseResumeCommandArgs(args);
    if (parsed.showHelp) {
        console.log(formatResumeHelp());
        return;
    }

    const session = await resolveHappySession(parsed.sessionId);
    const launch = buildResumeLaunch(session);

    if (!existsSync(launch.cwd)) {
        throw new Error(`Saved session path does not exist: ${launch.cwd}`);
    }

    const exitCode = await spawnResumeChild(launch);
    if (typeof exitCode === 'number' && exitCode !== 0) {
        process.exit(exitCode);
    }
}
