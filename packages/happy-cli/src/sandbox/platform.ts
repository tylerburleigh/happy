export function isSandboxRuntimePlatformSupported(platform: NodeJS.Platform = process.platform): boolean {
    return platform === 'darwin' || platform === 'linux';
}

export function supportedSandboxPlatformSummary(): string {
    return 'macOS and Linux';
}
