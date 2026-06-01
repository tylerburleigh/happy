import { describe, expect, it } from 'vitest';
import { isSandboxRuntimePlatformSupported, supportedSandboxPlatformSummary } from './platform';

describe('sandbox platform support', () => {
    it('allows sandbox-runtime supported platforms', () => {
        expect(isSandboxRuntimePlatformSupported('darwin')).toBe(true);
        expect(isSandboxRuntimePlatformSupported('linux')).toBe(true);
        expect(isSandboxRuntimePlatformSupported('win32')).toBe(false);
        expect(supportedSandboxPlatformSummary()).toBe('macOS and Linux');
    });
});
