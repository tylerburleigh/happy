import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { SandboxConfig } from '@/persistence';
import { buildSandboxRuntimeConfig } from './config';

export async function initializeSandbox(
    sandboxConfig: SandboxConfig,
    sessionPath: string,
): Promise<() => Promise<void>> {
    const runtimeConfig = buildSandboxRuntimeConfig(sandboxConfig, sessionPath);
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
): Promise<{ command: 'sh'; args: ['-c', string] }> {
    const commandLine = [command, ...args].map(quoteShellArg).join(' ');
    const wrappedCommand = await wrapCommand(commandLine);
    return {
        command: 'sh',
        args: ['-c', wrappedCommand],
    };
}

function quoteShellArg(value: string): string {
    if (/^[A-Za-z0-9_/:=-]+$/.test(value)) {
        return value;
    }
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
