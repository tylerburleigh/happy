import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { configuration } from '@/configuration';
import type { SandboxRuntimeBuildOptions } from './config';

type SandboxAgentName = 'claude' | 'codex';

const EXCLUDED_STATE_ENTRIES: Record<SandboxAgentName, Set<string>> = {
    claude: new Set(['projects']),
    codex: new Set(['history', 'logs', 'sessions']),
};

export type SandboxAgentState = {
    root: string;
    env: Record<string, string>;
    runtimeOptions: SandboxRuntimeBuildOptions;
};

function sanitizePathSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || randomUUID();
}

function expandHomePath(pathValue: string): string {
    return pathValue.replace(/^~(?=\/|$)/, homedir());
}

function defaultProviderStatePath(agent: SandboxAgentName): string {
    switch (agent) {
        case 'claude':
            return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
        case 'codex':
            return process.env.CODEX_HOME || join(homedir(), '.codex');
    }
}

async function providerSourceDenyReadPaths(source: string): Promise<string[]> {
    const denyReadPaths = [source];

    try {
        const realSource = await realpath(source);
        if (!denyReadPaths.includes(realSource)) {
            denyReadPaths.push(realSource);
        }
    } catch {
        // Missing source state is still denied by its configured path.
    }

    return denyReadPaths;
}

async function copyProviderStateEntries(source: string, destination: string, excluded?: Set<string>): Promise<void> {
    const entries = await readdir(source, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
        if (excluded?.has(entry.name)) {
            return;
        }

        const sourcePath = join(source, entry.name);
        const destinationPath = join(destination, entry.name);

        if (entry.isDirectory()) {
            await createPrivateManagedStateDir(destinationPath, 'provider state directory');
            await copyProviderStateEntries(sourcePath, destinationPath);
            return;
        }

        if (!entry.isFile()) {
            return;
        }

        await assertManagedStateDestinationAvailable(destinationPath);
        await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
        await chmod(destinationPath, 0o600);
    }));
}

async function copyProviderBootstrapState(agent: SandboxAgentName, source: string, destination: string): Promise<void> {
    let sourceStats: Awaited<ReturnType<typeof lstat>>;
    try {
        sourceStats = await lstat(source);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        throw error;
    }
    if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
        return;
    }

    await copyProviderStateEntries(source, destination, EXCLUDED_STATE_ENTRIES[agent]);
}

async function managedStateDirExists(pathValue: string, label: string): Promise<boolean> {
    try {
        const stats = await lstat(pathValue);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw new Error(`Sandbox ${label} must be a directory and may not be a symbolic link: ${pathValue}`);
        }
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function ensurePrivateManagedStateDir(pathValue: string, label: string): Promise<void> {
    if (!await managedStateDirExists(pathValue, label)) {
        await mkdir(pathValue, { mode: 0o700 });
        await managedStateDirExists(pathValue, label);
    }
    await chmod(pathValue, 0o700);
}

async function createPrivateManagedStateDir(pathValue: string, label: string): Promise<void> {
    try {
        await mkdir(pathValue, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`Sandbox ${label} already exists and will not be reused: ${pathValue}`);
        }
        throw error;
    }
    await managedStateDirExists(pathValue, label);
    await chmod(pathValue, 0o700);
}

async function assertManagedStateDestinationAvailable(pathValue: string): Promise<void> {
    try {
        await lstat(pathValue);
        throw new Error(`Sandbox provider state destination already exists and will not be reused: ${pathValue}`);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return;
        }
        throw error;
    }
}

export async function createSandboxAgentState(
    agent: SandboxAgentName,
    sessionId: string = randomUUID(),
): Promise<SandboxAgentState> {
    const tmpRoot = join(configuration.happyHomeDir, 'tmp');
    const stateRoot = join(tmpRoot, 'sandbox-state');
    const agentRoot = join(stateRoot, sanitizePathSegment(agent));
    const root = join(agentRoot, sanitizePathSegment(sessionId));
    const providerStatePath = join(root, agent);
    const sourceStatePath = resolve(expandHomePath(defaultProviderStatePath(agent)));
    const denyReadPaths = await providerSourceDenyReadPaths(sourceStatePath);

    await ensurePrivateManagedStateDir(configuration.happyHomeDir, 'Happy home directory');
    await ensurePrivateManagedStateDir(tmpRoot, 'temporary state root');
    await ensurePrivateManagedStateDir(stateRoot, 'sandbox state root');
    await ensurePrivateManagedStateDir(agentRoot, 'agent state root');
    await createPrivateManagedStateDir(root, 'session state root');
    await createPrivateManagedStateDir(providerStatePath, 'provider state root');
    await copyProviderBootstrapState(agent, sourceStatePath, providerStatePath);

    const env: Record<string, string> = {};
    if (agent === 'claude') {
        env.CLAUDE_CONFIG_DIR = providerStatePath;
    } else {
        env.CODEX_HOME = providerStatePath;
    }

    return {
        root,
        env,
        runtimeOptions: {
            agentStatePaths: [root, providerStatePath],
            denyReadPaths,
            includeSharedAgentStatePaths: false,
        },
    };
}
