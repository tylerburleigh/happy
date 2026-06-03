import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_CONTROL_TOKEN_HEADER } from './controlAuth';
import { createDaemonControlServerApp } from './controlServer';

type ControlServerApp = ReturnType<typeof createDaemonControlServerApp>;

describe('daemon control server auth', () => {
  let app: ControlServerApp | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  function startServer(options: {
    onHappySessionWebhook?: ReturnType<typeof vi.fn>;
    spawnSession?: ReturnType<typeof vi.fn>;
  } = {}) {
    return createDaemonControlServerApp({
      controlToken: 'test-token',
      getChildren: vi.fn(() => [
        {
          startedBy: 'daemon',
          happySessionId: 'session-1',
          pid: 123,
        },
      ]),
      stopSession: vi.fn(() => true),
      spawnSession: options.spawnSession ?? vi.fn(),
      requestShutdown: vi.fn(),
      onHappySessionWebhook: options.onHappySessionWebhook ?? vi.fn(),
    });
  }

  async function post(path: string, token?: string, payload: Record<string, unknown> = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers[DAEMON_CONTROL_TOKEN_HEADER] = token;
    }

    return app!.inject({
      method: 'POST',
      url: path,
      headers,
      payload,
    });
  }

  it('rejects requests without the daemon control token', async () => {
    app = startServer();

    const response = await post('/list');

    expect(response.statusCode).toBe(401);
  });

  it('rejects requests with the wrong daemon control token', async () => {
    app = startServer();

    const response = await post('/list', 'wrong-token');

    expect(response.statusCode).toBe(401);
  });

  it('accepts requests with the daemon control token', async () => {
    app = startServer();

    const response = await post('/list', 'test-token');
    const body = await response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({
      children: [
        {
          startedBy: 'daemon',
          happySessionId: 'session-1',
          pid: 123,
        },
      ],
    });
  });

  it('accepts valid session-started webhooks with decoded encryption data', async () => {
    const onHappySessionWebhook = vi.fn();
    app = startServer({ onHappySessionWebhook });
    const encryptionKey = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

    const response = await post('/session-started', 'test-token', {
      sessionId: 'session-1',
      metadata: {
        path: '/tmp/repo',
        hostPid: 123,
      },
      encryption: {
        encryptionKey,
        encryptionVariant: 'dataKey',
        seq: 1,
        metadataVersion: 2,
        agentStateVersion: 3,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(onHappySessionWebhook).toHaveBeenCalledWith(
      'session-1',
      {
        path: '/tmp/repo',
        hostPid: 123,
      },
      {
        encryptionKey: new Uint8Array(Buffer.from('0123456789abcdef0123456789abcdef')),
        encryptionVariant: 'dataKey',
        seq: 1,
        metadataVersion: 2,
        agentStateVersion: 3,
      },
    );
  });

  it('rejects malformed session-started payloads before invoking the webhook', async () => {
    const onHappySessionWebhook = vi.fn();
    app = startServer({ onHappySessionWebhook });

    const response = await post('/session-started', 'test-token', {
      sessionId: 'session\n1',
      metadata: 'not-metadata',
    });

    expect(response.statusCode).toBe(400);
    expect(onHappySessionWebhook).not.toHaveBeenCalled();
  });

  it('rejects malformed session-started encryption fields', async () => {
    const onHappySessionWebhook = vi.fn();
    app = startServer({ onHappySessionWebhook });

    const response = await post('/session-started', 'test-token', {
      sessionId: 'session-1',
      metadata: {},
      encryption: {
        encryptionKey: 'not base64\n',
        encryptionVariant: 'legacy',
        seq: 1.5,
        metadataVersion: 0,
        agentStateVersion: 0,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(onHappySessionWebhook).not.toHaveBeenCalled();
  });

  it('rejects malformed spawn-session environment variable keys', async () => {
    const spawnSession = vi.fn();
    app = startServer({ spawnSession });

    const response = await post('/spawn-session', 'test-token', {
      directory: '/tmp/repo',
      environmentVariables: {
        'BAD-KEY': 'value',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('rejects spawn-session environment variable values with control characters', async () => {
    const spawnSession = vi.fn();
    app = startServer({ spawnSession });

    const response = await post('/spawn-session', 'test-token', {
      directory: '/tmp/repo',
      environmentVariables: {
        GOOD_KEY: 'bad\nvalue',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('rejects daemon-spawn environment variables that can redirect Happy state', async () => {
    const spawnSession = vi.fn();
    app = startServer({ spawnSession });

    const response = await post('/spawn-session', 'test-token', {
      directory: '/tmp/repo',
      environmentVariables: {
        HAPPY_HOME_DIR: '/tmp/other-happy',
        CODEX_HOME: '/tmp/other-codex',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('rejects daemon-spawn environment variables that can inject code into the child process', async () => {
    const spawnSession = vi.fn();
    app = startServer({ spawnSession });

    const response = await post('/spawn-session', 'test-token', {
      directory: '/tmp/repo',
      environmentVariables: {
        PATH: '/tmp/malicious-bin',
        NODE_OPTIONS: '--require /tmp/hook.js',
        DYLD_INSERT_LIBRARIES: '/tmp/hook.dylib',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(spawnSession).not.toHaveBeenCalled();
  });
});
