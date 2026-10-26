import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';

/**
 * Blob storage for uploads, raw emails and attachments. Keys are always prefixed with the
 * orgId so one tenant's files never share a path with another's.
 */
export interface Storage {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** A short-lived URL a browser can open without a session. */
  signedUrl(key: string, opts: SignedUrlOptions): Promise<string>;
}

export type SignedUrlOptions = {
  filename: string;
  contentType: string;
  /** Default 5 minutes. */
  expiresInSec?: number;
  /** `inline` shows PDFs/images in the browser; `attachment` downloads. */
  disposition?: 'inline' | 'attachment';
};

const DEFAULT_URL_TTL_SEC = 300;

export function contentDisposition(disposition: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---- Local disk (development) -------------------------------------------------------------

/** Payload of a local signed file URL, verified by the API's /api/files route. */
export type FileTokenPayload = {
  k: string;
  e: number;
  f: string;
  t: string;
  d: 'inline' | 'attachment';
};

const fileTokenKey = crypto.createHash('sha256').update(`files:${env.ENCRYPTION_KEY}`).digest();
const sign = (body: string) =>
  crypto.createHmac('sha256', fileTokenKey).update(body).digest('base64url');

export function createFileToken(payload: FileTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

/** Returns the payload if the signature is valid and the link has not expired. */
export function verifyFileToken(token: string): FileTokenPayload | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as FileTokenPayload;
    return payload.e > Date.now() ? payload : null;
  } catch {
    return null;
  }
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

  async signedUrl(key: string, opts: SignedUrlOptions): Promise<string> {
    const token = createFileToken({
      k: key,
      e: Date.now() + (opts.expiresInSec ?? DEFAULT_URL_TTL_SEC) * 1000,
      f: opts.filename,
      t: opts.contentType,
      d: opts.disposition ?? 'inline',
    });
    // Relative: served by the API through the same origin as the web app.
    return `/api/files/${token}`;
  }
}

// ---- S3-compatible (AWS S3, Cloudflare R2, MinIO) -----------------------------------------

export class S3Storage implements Storage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    config: { region: string; endpoint?: string; accessKeyId: string; secretAccessKey: string },
  ) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      // MinIO and most S3-compatibles need path-style URLs; AWS works either way.
      forcePathStyle: Boolean(config.endpoint),
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async put(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`Empty object: ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async signedUrl(key: string, opts: SignedUrlOptions): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentType: opts.contentType,
      ResponseContentDisposition: contentDisposition(opts.disposition ?? 'inline', opts.filename),
    });
    return getSignedUrl(this.client, command, {
      expiresIn: opts.expiresInSec ?? DEFAULT_URL_TTL_SEC,
    });
  }
}

export function createStorage(): Storage {
  if (env.STORAGE_DRIVER === 's3') {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY || !env.S3_SECRET_KEY) {
      throw new Error('STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY and S3_SECRET_KEY');
    }
    return new S3Storage(env.S3_BUCKET, {
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
    });
  }
  return new LocalStorage(env.STORAGE_LOCAL_DIR);
}

/** `<orgId>/<area>/<yyyy-mm>/<random>-<safe filename>` */
export function storageKey(orgId: string, area: string, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80) || 'file';
  const month = new Date().toISOString().slice(0, 7);
  return `${orgId}/${area}/${month}/${crypto.randomBytes(8).toString('hex')}-${safe}`;
}
