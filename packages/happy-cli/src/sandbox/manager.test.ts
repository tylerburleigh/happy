import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { SandboxConfigSchema, type SandboxConfig } from '@/persistence';
import {
    initializeSandbox,
    wrapCommand,
    wrapForMcpTransport,
} from './manager';

const {
    mockInitialize,
    mockWrapWithSandbox,
    mockReset,
    mockBuildSandboxRuntimeConfig,
    mockEnsureSandboxRuntimeDirs,
} = vi.hoisted(() => ({
    mockInitialize: vi.fn(),
    mockWrapWithSandbox: vi.fn(),
    mockReset: vi.fn(),
    mockBuildSandboxRuntimeConfig: vi.fn(),
    mockEnsureSandboxRuntimeDirs: vi.fn(),
}));

vi.mock('@anthropic-ai/sandbox-runtime', () => ({
    SandboxManager: {
        initialize: mockInitialize,
        wrapWithSandbox: mockWrapWithSandbox,
        reset: mockReset,
    },
}));

vi.mock('./config', () => ({
    buildSandboxRuntimeConfig: mockBuildSandboxRuntimeConfig,
}));

vi.mock('./temp', () => ({
    ensureSandboxRuntimeDirs: mockEnsureSandboxRuntimeDirs,
}));

describe('sandbox manager', () => {
    const runtimeConfig: SandboxRuntimeConfig = {
        network: {
            allowedDomains: ['*'],
            deniedDomains: [],
            allowLocalBinding: true,
            allowUnixSockets: [],
        },
        filesystem: {
            denyRead: [],
            allowWrite: ['/tmp'],
            denyWrite: [],
        },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockBuildSandboxRuntimeConfig.mockReturnValue(runtimeConfig);
        mockEnsureSandboxRuntimeDirs.mockResolvedValue(undefined);
        mockWrapWithSandbox.mockResolvedValue('sandbox wrapped command');
    });

    it('initializes sandbox for allowed network mode and returns cleanup function', async () => {
        const sandboxConfig: SandboxConfig = SandboxConfigSchema.parse({
            enabled: true,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: [],
            extraWritePaths: ['/tmp'],
            denyWritePaths: [],
            networkMode: 'allowed',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: true,
        });

        const cleanup = await initializeSandbox(sandboxConfig, '/workspace/session');

        expect(mockEnsureSandboxRuntimeDirs).toHaveBeenCalledWith('/workspace/session');
        expect(mockBuildSandboxRuntimeConfig).toHaveBeenCalledWith(sandboxConfig, '/workspace/session', undefined);
        expect(mockInitialize).toHaveBeenCalledWith(runtimeConfig);

        await cleanup();
        expect(mockReset).toHaveBeenCalledTimes(1);
    });

    it('initializes sandbox runtime for blocked network mode', async () => {
        const sandboxConfig: SandboxConfig = SandboxConfigSchema.parse({
            enabled: true,
            sessionIsolation: 'workspace',
            customWritePaths: [],
            denyReadPaths: [],
            extraWritePaths: ['/tmp'],
            denyWritePaths: [],
            networkMode: 'blocked',
            allowedDomains: [],
            deniedDomains: [],
            allowLocalBinding: false,
        });

        await initializeSandbox(sandboxConfig, '/workspace/session');

        expect(mockInitialize).toHaveBeenCalledWith(runtimeConfig);
    });

    it('wrapCommand delegates to SandboxManager.wrapWithSandbox', async () => {
        const wrapped = await wrapCommand('node script.js');

        expect(mockWrapWithSandbox).toHaveBeenCalledWith('node script.js');
        expect(wrapped).toBe('sandbox wrapped command');
    });

    it('wrapForMcpTransport returns /bin/sh -c wrapped command', async () => {
        mockWrapWithSandbox.mockResolvedValue('sandbox codex command');

        const wrapped = await wrapForMcpTransport('codex', ['mcp-server']);

        expect(mockWrapWithSandbox).toHaveBeenCalledWith("'codex' 'mcp-server'");
        expect(wrapped).toEqual({
            command: '/bin/sh',
            args: ['-c', 'sandbox codex command'],
        });
    });

    it('shell-quotes MCP transport command arguments before wrapping', async () => {
        mockWrapWithSandbox.mockResolvedValue('sandbox quoted command');

        await wrapForMcpTransport('/path with spaces/tool', ['--name', "it's fine"]);

        expect(mockWrapWithSandbox).toHaveBeenCalledWith("'/path with spaces/tool' '--name' 'it'\\''s fine'");
    });

    it('rejects empty MCP transport commands before wrapping', async () => {
        await expect(wrapForMcpTransport('', [])).rejects.toThrow('Sandbox MCP command may not be empty');

        expect(mockWrapWithSandbox).not.toHaveBeenCalled();
    });

    it('rejects MCP transport command parts with control characters before wrapping', async () => {
        await expect(wrapForMcpTransport('codex', ['mcp\nserver'])).rejects.toThrow('Sandbox MCP command may not contain control characters');

        expect(mockWrapWithSandbox).not.toHaveBeenCalled();
    });

});
