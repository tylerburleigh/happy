/**
 * Generate temporary settings file with Claude hooks for session tracking
 * 
 * Creates a settings.json file that configures Claude's SessionStart hook
 * to notify our HTTP server when sessions change (new session, resume, compact, etc.)
 */

import { join, resolve } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';
import { ensurePrivateDirSync, writePrivateFileSync } from '@/utils/privateFiles';

/**
 * Generate a temporary settings file with SessionStart hook configuration
 * 
 * @param port - The port where Happy server is listening
 * @returns Path to the generated settings file
 */
export function generateHookSettingsFile(port: number, options?: { enableSandboxGuards?: boolean }): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    ensurePrivateDirSync(hooksDir);

    // Unique filename per process to avoid conflicts
    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    // Path to the hook forwarder script
    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    const hookCommand = `node "${forwarderScript}" ${port}`;
    const sandboxGuardScript = resolve(projectPath(), 'scripts', 'sandbox_secret_guard.cjs');
    const sandboxGuardCommand = `node "${sandboxGuardScript}"`;

    const settings: {
        hooks: Record<string, Array<{
            matcher: string;
            hooks: Array<{ type: 'command'; command: string }>;
        }>>;
    } = {
        hooks: {
            SessionStart: [
                {
                    matcher: "*",
                    hooks: [
                        {
                            type: "command",
                            command: hookCommand
                        }
                    ]
                }
            ]
        }
    };

    if (options?.enableSandboxGuards) {
        settings.hooks.PreToolUse = [
            {
                matcher: "Bash",
                hooks: [
                    {
                        type: "command",
                        command: sandboxGuardCommand,
                    },
                ],
            },
        ];
    }

    writePrivateFileSync(filepath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Created hook settings file: ${filepath}`);

    return filepath;
}

/**
 * Clean up the temporary hook settings file
 * 
 * @param filepath - Path to the settings file to remove
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook settings file: ${error}`);
    }
}
