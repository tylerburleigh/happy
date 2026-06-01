import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'path';
import { validatePath, validateRealPath } from './pathSecurity';

describe('validatePath', () => {
    const workingDir = resolve('/home/user/project');

    it('should allow paths within working directory', () => {
        expect(validatePath(resolve('/home/user/project/file.txt'), workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project/file.txt'),
        });
        expect(validatePath('file.txt', workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project/file.txt'),
        });
        expect(validatePath('./src/file.txt', workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project/src/file.txt'),
        });
    });

    it('should reject paths outside working directory', () => {
        const result = validatePath(resolve('/etc/passwd'), workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the working directory');
    });

    it('should prevent path traversal attacks', () => {
        const result = validatePath('../../.ssh/id_rsa', workingDir);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('outside the working directory');
    });

    it('should allow the working directory itself', () => {
        expect(validatePath('.', workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project'),
        });
        expect(validatePath(workingDir, workingDir)).toEqual({
            valid: true,
            resolvedPath: resolve('/home/user/project'),
        });
    });

    it('should reject symlinks that resolve outside the working directory', async () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-path-security-'));
        const workspace = join(root, 'workspace');
        const outside = join(root, 'outside');
        mkdirSync(workspace);
        mkdirSync(outside);
        writeFileSync(join(outside, 'secret.txt'), 'secret');
        symlinkSync(join(outside, 'secret.txt'), join(workspace, 'secret-link.txt'));

        const result = await validateRealPath('secret-link.txt', workspace);

        expect(result.valid).toBe(false);
        expect(result.error).toContain('resolves outside the working directory');
    });

    it('should reject writes through symlinked parent directories', async () => {
        const root = mkdtempSync(join(tmpdir(), 'happy-path-security-'));
        const workspace = join(root, 'workspace');
        const outside = join(root, 'outside');
        mkdirSync(workspace);
        mkdirSync(outside);
        symlinkSync(outside, join(workspace, 'outside-link'));

        const result = await validateRealPath('outside-link/new-file.txt', workspace, {
            allowMissingTarget: true,
        });

        expect(result.valid).toBe(false);
        expect(result.error).toContain('resolves outside the working directory');
    });
});
