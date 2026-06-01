import { afterEach, describe, expect, it } from 'vitest';
import type { Metadata } from '@/api/types';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { createDaemonControlServer } from './controlServer';

describe('daemon control server authorization', () => {
  let app: ReturnType<typeof createDaemonControlServer> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function createServer() {
    app = createDaemonControlServer({
      controlToken: 'test-control-token',
      getChildren: () => [],
      stopSession: () => true,
      spawnSession: async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({
        type: 'success',
        sessionId: 'spawned-test-session',
      }),
      requestShutdown: () => undefined,
      onHappySessionWebhook: (_sessionId: string, _metadata: Metadata) => undefined,
    });

    return app;
  }

  it('rejects control requests without the bearer token', async () => {
    const response = await createServer().inject({
      url: '/list',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects browser-like requests missing the daemon control header', async () => {
    const response = await createServer().inject({
      url: '/list',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-control-token',
      },
      body: '{}',
    });

    expect(response.statusCode).toBe(403);
  });

  it('accepts control requests with the bearer token and daemon control header', async () => {
    const response = await createServer().inject({
      url: '/list',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-control-token',
        'X-Happy-Daemon-Control': 'true',
      },
      body: '{}',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ children: [] });
  });
});
