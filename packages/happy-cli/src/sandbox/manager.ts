import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '@/persistence';
import { buildSandboxRuntimeConfig, type SandboxRuntimeBuildOptions } from './config';
import { ensureSandboxRuntimeDirs } from './temp';

export function quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function joinShellCommand(command: string, args: string[]): string {
    if (command.trim().length === 0) {
        throw new Error('Sandbox MCP command may not be empty');
    }

    const commandParts = [command, ...args];
    const unsafePart = commandParts.find((part) => /[\u0000-\u001f\u007f]/.test(part));
    if (unsafePart !== undefined) {
        throw new Error('Sandbox MCP command may not contain control characters');
    }

    return [command, ...args].map(quoteShellArg).join(' ');
}

export async function initializeSandbox(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
    options?: SandboxRuntimeBuildOptions,
): Promise<() => Promise<void>> {
    await ensureSandboxRuntimeDirs(sessionPath);
    const runtimeConfig = buildSandboxRuntimeConfig(sandboxConfig, sessionPath, options);
    await SandboxManager.initialize(runtimeConfig);

    return async () => {
        await SandboxManager.reset();
    };
}

export async function wrapCommand(command: string): Promise<string> {
    return SandboxManager.wrapWithSandbox(command);
}

export async function wrapForMcpTransport(
    command: string,
    args: string[],
): Promise<{ command: string; args: ['-c', string] }> {
    const wrappedCommand = await wrapCommand(joinShellCommand(command, args));
    return {
        command: '/bin/sh',
        args: ['-c', wrappedCommand],
    };
}
