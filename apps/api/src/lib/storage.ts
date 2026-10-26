import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env';

/**
 * Blob storage for uploads, raw emails and attachments. Keys are always prefixed with the
 * orgId so one tenant's files never share a path with another's.
 * TODO(M3): S3-compatible driver (AWS S3 / Cloudflare R2 / MinIO) with signed URLs.
 */
export interface Storage {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class LocalStorage implements Storage {
  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep))
      throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const file = this.resolve(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }
}

export function createStorage(): Storage {
  return new LocalStorage(env.STORAGE_LOCAL_DIR);
}

/** `<orgId>/<area>/<yyyy-mm>/<random>-<safe filename>` */
export function storageKey(orgId: string, area: string, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file';
  const month = new Date().toISOString().slice(0, 7);
  return `${orgId}/${area}/${month}/${crypto.randomBytes(8).toString('hex')}-${safe}`;
}
