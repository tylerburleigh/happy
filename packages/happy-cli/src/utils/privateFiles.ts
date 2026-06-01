import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(path, PRIVATE_DIR_MODE).catch(() => { });
}

export function ensurePrivateDirSync(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    chmodSync(path, PRIVATE_DIR_MODE);
  } catch { }
}

export async function writePrivateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: PRIVATE_FILE_MODE });
  await chmod(path, PRIVATE_FILE_MODE).catch(() => { });
}

export function writePrivateFileSync(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf-8', mode: PRIVATE_FILE_MODE });
  try {
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch { }
}
