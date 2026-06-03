import { randomBytes, timingSafeEqual } from 'node:crypto';

export const DAEMON_CONTROL_TOKEN_HEADER = 'x-happy-daemon-token';

export function generateDaemonControlToken(): string {
  return randomBytes(32).toString('hex');
}

export function isValidDaemonControlToken(providedToken: string | undefined, expectedToken: string): boolean {
  if (!providedToken || !expectedToken) {
    return false;
  }

  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);

  if (provided.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(provided, expected);
}
