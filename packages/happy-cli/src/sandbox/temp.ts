import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

function sandboxTempKey(sessionPath: string): string {
    return createHash('sha256').update(resolve(sessionPath)).digest('hex').slice(0, 16);
}

export function getSandboxTempDir(sessionPath: string): string {
    return join(configuration.happyHomeDir, 'tmp', 'sandbox-temp', sandboxTempKey(sessionPath));
}

export function getSandboxHomeDir(sessionPath: string): string {
    return join(configuration.happyHomeDir, 'tmp', 'sandbox-home', sandboxTempKey(sessionPath));
}

export function buildSandboxTempEnv(sessionPath: string): Record<string, string> {
    const tempDir = getSandboxTempDir(sessionPath);
    return {
        TMPDIR: tempDir,
        TMP: tempDir,
        TEMP: tempDir,
    };
}

export function buildSandboxRuntimeEnv(sessionPath: string): Record<string, string> {
    const homeDir = getSandboxHomeDir(sessionPath);
    const configHome = join(homeDir, '.config');

    return {
        HOME: homeDir,
        XDG_CONFIG_HOME: configHome,
        XDG_CACHE_HOME: join(homeDir, '.cache'),
        XDG_DATA_HOME: join(homeDir, '.local', 'share'),
        XDG_STATE_HOME: join(homeDir, '.local', 'state'),
        AWS_CONFIG_FILE: join(homeDir, '.aws', 'config'),
        AWS_SHARED_CREDENTIALS_FILE: join(homeDir, '.aws', 'credentials'),
        AZURE_CONFIG_DIR: join(homeDir, '.azure'),
        CARGO_HOME: join(homeDir, '.cargo'),
        CLOUDSDK_CONFIG: join(configHome, 'gcloud'),
        DOCKER_CONFIG: join(homeDir, '.docker'),
        GH_CONFIG_DIR: join(configHome, 'gh'),
        GIT_CONFIG_GLOBAL: join(homeDir, '.gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        GNUPGHOME: join(homeDir, '.gnupg'),
        KUBECONFIG: join(homeDir, '.kube', 'config'),
        NPM_CONFIG_USERCONFIG: join(homeDir, '.npmrc'),
        PYTHONUSERBASE: join(homeDir, '.local'),
        RUSTUP_HOME: join(homeDir, '.rustup'),
        ...buildSandboxTempEnv(sessionPath),
    };
}

function getSandboxRuntimeDirPaths(sessionPath: string): string[] {
    const homeDir = getSandboxHomeDir(sessionPath);
    const configHome = join(homeDir, '.config');
    const tmpRoot = join(configuration.happyHomeDir, 'tmp');
    const tempRoot = join(tmpRoot, 'sandbox-temp');
    const homeRoot = join(tmpRoot, 'sandbox-home');

    return [
        configuration.happyHomeDir,
        tmpRoot,
        tempRoot,
        homeRoot,
        homeDir,
        getSandboxTempDir(sessionPath),
        configHome,
        join(homeDir, '.cache'),
        join(homeDir, '.local'),
        join(homeDir, '.local', 'share'),
        join(homeDir, '.local', 'state'),
        join(homeDir, '.aws'),
        join(homeDir, '.azure'),
        join(homeDir, '.cargo'),
        join(homeDir, '.docker'),
        join(homeDir, '.gnupg'),
        join(homeDir, '.kube'),
        join(homeDir, '.rustup'),
        join(configHome, 'gcloud'),
        join(configHome, 'gh'),
    ];
}

export async function ensureSandboxTempDir(sessionPath: string): Promise<string> {
    const tempDir = getSandboxTempDir(sessionPath);
    await ensurePrivateDir(tempDir);

    return tempDir;
}

async function assertManagedRuntimeDir(pathValue: string): Promise<boolean> {
    try {
        const stats = await lstat(pathValue);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw new Error(`Sandbox managed runtime path must be a directory and may not be a symbolic link: ${pathValue}`);
        }
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

function assertManagedRuntimeDirSync(pathValue: string): boolean {
    try {
        const stats = lstatSync(pathValue);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
            throw new Error(`Sandbox managed runtime path must be a directory and may not be a symbolic link: ${pathValue}`);
        }
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function ensurePrivateDir(pathValue: string): Promise<void> {
    if (!await assertManagedRuntimeDir(pathValue)) {
        await mkdir(pathValue, { recursive: true, mode: 0o700 });
        await assertManagedRuntimeDir(pathValue);
    }

    try {
        await chmod(pathValue, 0o700);
    } catch (error) {
        logger.debug('[SANDBOX] Failed to chmod sandbox runtime dir:', error);
    }
}

function ensurePrivateDirSync(pathValue: string): void {
    if (!assertManagedRuntimeDirSync(pathValue)) {
        mkdirSync(pathValue, { recursive: true, mode: 0o700 });
        assertManagedRuntimeDirSync(pathValue);
    }

    try {
        chmodSync(pathValue, 0o700);
    } catch (error) {
        logger.debug('[SANDBOX] Failed to chmod sandbox runtime dir:', error);
    }
}

export async function ensureSandboxRuntimeDirs(sessionPath: string): Promise<void> {
    for (const pathValue of getSandboxRuntimeDirPaths(sessionPath)) {
        await ensurePrivateDir(pathValue);
    }
}

export function ensureSandboxRuntimeDirsSync(sessionPath: string): void {
    for (const pathValue of getSandboxRuntimeDirPaths(sessionPath)) {
        ensurePrivateDirSync(pathValue);
    }
}
