/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { decodeBase64 } from '@/api/encryption';
import { TrackedSession, SessionEncryptionData } from './types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { DAEMON_CONTROL_TOKEN_HEADER, isValidDaemonControlToken } from './controlAuth';
import { validateCallerSpawnEnvironmentVariables } from './spawnEnv';

export type DaemonControlServerOptions = {
  controlToken: string;
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => boolean;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata, encryption?: SessionEncryptionData) => void;
};

const MAX_CONTROL_STRING_LENGTH = 4096;
const MAX_ENCRYPTION_KEY_LENGTH = 4096;

const controlStringSchema = z.string()
  .min(1)
  .max(MAX_CONTROL_STRING_LENGTH)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'must not contain control characters');

const encryptionKeySchema = z.string()
  .min(1)
  .max(MAX_ENCRYPTION_KEY_LENGTH)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'must not contain control characters')
  .refine(
    (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value),
    'must be standard base64',
  );

const controlVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const sessionStartedMetadataSchema = z.record(z.string(), z.unknown());

const environmentVariablesSchema = z.record(z.string(), z.string()).superRefine((env, ctx) => {
  for (const issue of validateCallerSpawnEnvironmentVariables(env)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: issue.key ? [issue.key] : [],
      message: issue.message,
    });
  }
});

export function createDaemonControlServerApp({
  controlToken,
  getChildren,
  stopSession,
  spawnSession,
  requestShutdown,
  onHappySessionWebhook
}: DaemonControlServerOptions): FastifyInstance {
    const app = fastify({
      logger: false, // We use our own logger
      bodyLimit: 1024 * 1024,
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    app.addHook('preHandler', async (request, reply) => {
      const headerValue = request.headers[DAEMON_CONTROL_TOKEN_HEADER];
      const providedToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;

      if (!isValidDaemonControlToken(providedToken, controlToken)) {
        logger.debug(`[CONTROL SERVER] Unauthorized request: ${request.method} ${request.url}`);
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    });

    // Session reports itself after creation
    typed.post('/session-started', {
      schema: {
        body: z.object({
          sessionId: controlStringSchema,
          metadata: sessionStartedMetadataSchema,
          encryption: z.object({
            encryptionKey: encryptionKeySchema,
            encryptionVariant: z.enum(['legacy', 'dataKey']),
            seq: controlVersionSchema,
            metadataVersion: controlVersionSchema,
            agentStateVersion: controlVersionSchema,
          }).optional()
        }),
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      const { sessionId, metadata, encryption } = request.body;

      logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);

      let encryptionData: SessionEncryptionData | undefined;
      if (encryption) {
        encryptionData = {
          encryptionKey: decodeBase64(encryption.encryptionKey),
          encryptionVariant: encryption.encryptionVariant,
          seq: encryption.seq,
          metadataVersion: encryption.metadataVersion,
          agentStateVersion: encryption.agentStateVersion,
        };
      }

      onHappySessionWebhook(sessionId, metadata as Metadata, encryptionData);

      return { status: 'ok' as const };
    });

    // List all tracked sessions
    typed.post('/list', {
      schema: {
        response: {
          200: z.object({
            children: z.array(z.object({
              startedBy: z.string(),
              happySessionId: z.string(),
              pid: z.number()
            }))
          })
        }
      }
    }, async () => {
      const children = getChildren();
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return { 
        children: children
          .filter(child => child.happySessionId !== undefined)
          .map(child => ({
            startedBy: child.startedBy,
            happySessionId: child.happySessionId!,
            pid: child.pid
          }))
      }
    });

    // Stop specific session
    typed.post('/stop-session', {
      schema: {
        body: z.object({
          sessionId: controlStringSchema
        }),
        response: {
          200: z.object({
            success: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { sessionId } = request.body;

      logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
      const success = stopSession(sessionId);
      return { success };
    });

    // Spawn new session
    typed.post('/spawn-session', {
      schema: {
        body: z.object({
          directory: controlStringSchema,
          sessionId: controlStringSchema.optional(),
          agent: z.enum(['claude', 'codex', 'gemini', 'openclaw']).optional(),
          environmentVariables: environmentVariablesSchema.optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            approvedNewDirectoryCreation: z.boolean().optional()
          }),
          409: z.object({
            success: z.boolean(),
            requiresUserApproval: z.boolean().optional(),
            actionRequired: z.string().optional(),
            directory: z.string().optional()
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional()
          })
        }
      }
    }, async (request, reply) => {
      const { directory, sessionId, agent, environmentVariables } = request.body;

      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}, agent=${agent || 'default'}`);
      const result = await spawnSession({ directory, sessionId, agent, environmentVariables });

      switch (result.type) {
        case 'success':
          // Check if sessionId exists, if not return error
          if (!result.sessionId) {
            reply.code(500);
            return {
              success: false,
              error: 'Failed to spawn session: no session ID returned'
            };
          }
          return {
            success: true,
            sessionId: result.sessionId,
            approvedNewDirectoryCreation: true
          };
        
        case 'requestToApproveDirectoryCreation':
          reply.code(409); // Conflict - user input needed
          return { 
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: result.directory
          };
        
        case 'error':
          reply.code(500);
          return { 
            success: false,
            error: result.errorMessage
          };
      }
    });

    // Stop daemon
    typed.post('/stop', {
      schema: {
        response: {
          200: z.object({
            status: z.string()
          })
        }
      }
    }, async () => {
      logger.debug('[CONTROL SERVER] Stop daemon request received');

      // Give time for response to arrive
      setTimeout(() => {
        logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
        requestShutdown();
      }, 50);

      return { status: 'stopping' };
    });

    return app;
}

export function startDaemonControlServer(options: DaemonControlServerOptions): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const app = createDaemonControlServerApp(options);

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        reject(err);
        return;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
