import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { notFound, param } from '@keyless/core/lib/http';
import { contentDisposition, verifyFileToken, type Storage } from '@keyless/core/lib/storage';
import { Attachment } from '@keyless/core/models/Attachment';

const VIEWABLE = /^(application\/pdf|image\/(png|jpe?g|gif|webp))$/i;

/**
 * Serves files behind short-lived signed links (local storage driver). The signature is the
 * authorisation, so links work in <iframe>/<img>/new tabs without session cookies, and expire.
 */
export function filesRouter({ storage }: { storage: Storage }): Router {
  const r = Router();
  r.get('/:token', async (req, res) => {
    const payload = verifyFileToken(param(req, 'token'));
    if (!payload) throw notFound('This link has expired - reopen the file from Keyless');
    let body: Buffer | undefined;
    try {
      body = await storage.get(payload.k);
    } catch {
      // 1. Try finding in MongoDB Attachment document (persisted across cloud container restarts)
      try {
        const att = await Attachment.findOne({ storageKey: payload.k });
        if (att && att.data) {
          body = att.data;
          void storage.put(payload.k, body, payload.t).catch(() => {});
        }
      } catch {}

      // 2. If not found in DB, check repository sample_files by filename
      if (!body && payload.f) {
        const sampleCandidates = [
          path.resolve(process.cwd(), 'sample_files', payload.f),
          path.resolve(process.cwd(), 'apps', 'web', 'public', 'samples', payload.f),
          path.resolve(process.cwd(), 'sample_files', path.basename(payload.f)),
        ];
        for (const p of sampleCandidates) {
          try {
            body = await fs.readFile(p);
            void storage.put(payload.k, body, payload.t).catch(() => {});
            break;
          } catch {}
        }
      }
    }

    if (!body) {
      throw notFound('File not found');
    }
    res.setHeader('Content-Type', payload.t);
    res.setHeader('Content-Disposition', contentDisposition(payload.d, payload.f));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (VIEWABLE.test(payload.t)) {
      // Browsers' PDF viewers refuse to render under a restrictive CSP; these types can't run script.
      res.removeHeader('Content-Security-Policy');
    } else {
      // Anything else (HTML, SVG, unknown) must never run script on our origin.
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    }
    res.send(body);
  });
  return r;
}
