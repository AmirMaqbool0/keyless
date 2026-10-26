import { Router } from 'express';
import { notFound, param } from '@keyless/core/lib/http';
import { contentDisposition, verifyFileToken, type Storage } from '@keyless/core/lib/storage';

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
    let body: Buffer;
    try {
      body = await storage.get(payload.k);
    } catch {
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
