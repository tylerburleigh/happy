import { dirname, resolve, sep } from 'path';
import { realpath } from 'node:fs/promises';

export interface PathValidationResult {
    valid: boolean;
    resolvedPath?: string;
    error?: string;
}

/**
 * Validates that a path is within the allowed working directory
 * @param targetPath - The path to validate (can be relative or absolute)
 * @param workingDirectory - The session's working directory (must be absolute)
 * @returns Validation result
 */
export function validatePath(targetPath: string, workingDirectory: string): PathValidationResult {
    // Resolve both paths to absolute paths to handle path traversal attempts
    const resolvedTarget = resolve(workingDirectory, targetPath);
    const resolvedWorkingDir = resolve(workingDirectory);

    // Check if the resolved target path starts with the working directory
    // Uses path.sep to work correctly on both Windows (\) and Unix (/)
    if (!resolvedTarget.startsWith(resolvedWorkingDir + sep) && resolvedTarget !== resolvedWorkingDir) {
        return {
            valid: false,
            resolvedPath: resolvedTarget,
            error: `Access denied: Path '${targetPath}' is outside the working directory`
        };
    }

    return { valid: true, resolvedPath: resolvedTarget };
}

export async function validateRealPath(
    targetPath: string,
    workingDirectory: string,
    options: { allowMissingTarget?: boolean } = {},
): Promise<PathValidationResult> {
    const lexical = validatePath(targetPath, workingDirectory);
    if (!lexical.valid || !lexical.resolvedPath) {
        return lexical;
    }

    let realWorkingDir: string;
    try {
        realWorkingDir = await realpath(resolve(workingDirectory));
    } catch (error) {
        return {
            valid: false,
            resolvedPath: lexical.resolvedPath,
            error: error instanceof Error ? error.message : 'Failed to resolve working directory',
        };
    }

    let realTarget: string;
    try {
        realTarget = await realpath(lexical.resolvedPath);
    } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (!options.allowMissingTarget || nodeError.code !== 'ENOENT') {
            return {
                valid: false,
                resolvedPath: lexical.resolvedPath,
                error: error instanceof Error ? error.message : 'Failed to resolve target path',
            };
        }

        try {
            realTarget = await realpath(dirname(lexical.resolvedPath));
        } catch (parentError) {
            return {
                valid: false,
                resolvedPath: lexical.resolvedPath,
                error: parentError instanceof Error ? parentError.message : 'Failed to resolve parent directory',
            };
        }
    }

    if (!realTarget.startsWith(realWorkingDir + sep) && realTarget !== realWorkingDir) {
        return {
            valid: false,
            resolvedPath: lexical.resolvedPath,
            error: `Access denied: Path '${targetPath}' resolves outside the working directory`,
        };
    }

    return { valid: true, resolvedPath: lexical.resolvedPath };
}
