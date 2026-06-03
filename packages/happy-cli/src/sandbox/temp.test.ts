import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const mocks = vi.hoisted(() => {
    const fs = require('node:fs') as typeof import('node:fs');
    const os = require('node:os') as typeof import('node:os');
    const path = require('node:path') as typeof import('node:path');

    return {
        happyHomeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'happy-sandbox-temp-home-')),
    };
});

vi.mock('@/configuration', () => ({
    configuration: {
        get happyHomeDir() {
            return mocks.happyHomeDir;
        },
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

import {
    buildSandboxRuntimeEnv,
    buildSandboxTempEnv,
    ensureSandboxRuntimeDirs,
    ensureSandboxRuntimeDirsSync,
    getSandboxHomeDir,
    getSandboxTempDir,
} from './temp';

describe('sandbox temp helpers', () => {
    afterEach(() => {
        rmSync(mocks.happyHomeDir, { recursive: true, force: true });
        mocks.happyHomeDir = mkdtempSync(join(tmpdir(), 'happy-sandbox-temp-home-'));
    });

    it('builds a deterministic Happy-owned temp env for a session path', () => {
        const sessionPath = '/workspace/project';
        const tempDir = getSandboxTempDir(sessionPath);

        expect(buildSandboxTempEnv(sessionPath)).toEqual({
            TMPDIR: tempDir,
            TMP: tempDir,
            TEMP: tempDir,
        });
        expect(tempDir).toContain('/tmp/sandbox-temp/');
    });

    it('builds a managed HOME together with temp env', () => {
        const sessionPath = '/workspace/project';
        const homeDir = getSandboxHomeDir(sessionPath);

        expect(buildSandboxRuntimeEnv(sessionPath)).toEqual(expect.objectContaining({
            HOME: homeDir,
            XDG_CONFIG_HOME: join(homeDir, '.config'),
            XDG_CACHE_HOME: join(homeDir, '.cache'),
            AWS_CONFIG_FILE: join(homeDir, '.aws', 'config'),
            AWS_SHARED_CREDENTIALS_FILE: join(homeDir, '.aws', 'credentials'),
            CLOUDSDK_CONFIG: join(homeDir, '.config', 'gcloud'),
            DOCKER_CONFIG: join(homeDir, '.docker'),
            GH_CONFIG_DIR: join(homeDir, '.config', 'gh'),
            GIT_CONFIG_GLOBAL: join(homeDir, '.gitconfig'),
            GIT_CONFIG_NOSYSTEM: '1',
            GNUPGHOME: join(homeDir, '.gnupg'),
            KUBECONFIG: join(homeDir, '.kube', 'config'),
            NPM_CONFIG_USERCONFIG: join(homeDir, '.npmrc'),
            ...buildSandboxTempEnv(sessionPath),
        }));
        expect(homeDir).toContain('/tmp/sandbox-home/');
    });

    it('rejects symlinked managed runtime directories', async () => {
        if (process.platform === 'win32') {
            return;
        }

        const sessionPath = '/workspace/project';
        const homeDir = getSandboxHomeDir(sessionPath);
        const targetDir = mkdtempSync(join(tmpdir(), 'happy-sandbox-home-target-'));

        try {
            mkdirSync(dirname(homeDir), { recursive: true });
            symlinkSync(targetDir, homeDir, 'dir');

            await expect(ensureSandboxRuntimeDirs(sessionPath)).rejects.toThrow(
                /managed runtime path must be a directory and may not be a symbolic link/,
            );
        } finally {
            rmSync(targetDir, { recursive: true, force: true });
        }
    });

    it('rejects symlinked managed runtime parent roots', () => {
        if (process.platform === 'win32') {
            return;
        }

        const sessionPath = '/workspace/project';
        const targetDir = mkdtempSync(join(tmpdir(), 'happy-sandbox-tmp-target-'));

        try {
            symlinkSync(targetDir, join(mocks.happyHomeDir, 'tmp'), 'dir');

            expect(() => ensureSandboxRuntimeDirsSync(sessionPath)).toThrow(
                /managed runtime path must be a directory and may not be a symbolic link/,
            );
        } finally {
            rmSync(targetDir, { recursive: true, force: true });
        }
    });

    it('rejects a symlinked Happy home before creating sandbox runtime dirs', () => {
        if (process.platform === 'win32') {
            return;
        }

        const targetDir = mkdtempSync(join(tmpdir(), 'happy-home-target-'));
        const symlinkHome = join(tmpdir(), `happy-home-link-${Date.now()}`);

        try {
            rmSync(mocks.happyHomeDir, { recursive: true, force: true });
            symlinkSync(targetDir, symlinkHome, 'dir');
            mocks.happyHomeDir = symlinkHome;

            expect(() => ensureSandboxRuntimeDirsSync('/workspace/project')).toThrow(
                /managed runtime path must be a directory and may not be a symbolic link/,
            );
        } finally {
            rmSync(symlinkHome, { recursive: true, force: true });
            rmSync(targetDir, { recursive: true, force: true });
        }
    });
});
