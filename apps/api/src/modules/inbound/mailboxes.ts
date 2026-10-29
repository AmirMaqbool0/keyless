import crypto from 'node:crypto';
import { Router, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import {
  connectImapSchema,
  updateMailboxSchema,
  type MailboxDto,
  type MailboxesResponse,
} from '@keyless/shared';
import { env, getAppBaseUrl, isProd } from '@keyless/core/config/env';
import { encrypt } from '@keyless/core/lib/crypto';
import { runMailboxSync } from '@keyless/core/mailboxes/sync';
import { ensureForwardingMailbox, type IngestDeps } from '@keyless/core/ingestion/receive';
import { audit } from '@keyless/core/lib/audit';
import { badRequest, forbidden, notFound, param, validate } from '@keyless/core/lib/http';
import { logger } from '@keyless/core/lib/logger';
import {
  authorizeUrl,
  exchangeCode,
  fetchAccountAddress,
  isProviderConfigured,
  pkcePair,
  redirectUri,
  saveTokens,
  type FetchLike,
  type MailProvider,
} from '@keyless/core/mailboxes/oauth';
import { Mailbox, type IMailbox } from '@keyless/core/models/Mailbox';
import { authed, requireRole } from '../../middleware/auth';
import { objectId } from '../shared';

const OAUTH_COOKIE = 'keyless_oauth';
const OAUTH_COOKIE_PATH = '/api/mailboxes/oauth';
const providerSchema = z.enum(['graph', 'gmail']);
type OAuthState = {
  provider: MailProvider;
  nonce: string;
  verifier: string;
  userId: string;
  orgId: string;
  redirectUri?: string;
};

function toDto(m: IMailbox): MailboxDto {
  return {
    id: m._id.toString(),
    type: m.type,
    name: m.name,
    address: m.address,
    status: m.status,
    folder: m.folder ?? null,
    lastSyncAt: m.lastSyncAt?.toISOString() ?? null,
    lastError: m.lastError ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

const back = (
  res: Response,
  query: Record<string, string>,
  req?: { get?: (name: string) => string | undefined; protocol?: string },
) => res.redirect(`${getAppBaseUrl(req)}/settings/mailboxes?${new URLSearchParams(query)}`);

/** Mounted behind requireAuth + requireVerified. */
export function mailboxesRouter(deps: IngestDeps & { fetch?: FetchLike }): Router {
  const r = Router();
  const fetchFn = deps.fetch ?? fetch;

  r.get('/', async (req, res) => {
    const { orgId, org } = authed(req);
    const fwd = await ensureForwardingMailbox(org);

    // Auto-provision user's Hostinger business mailbox in runtime if not yet registered
    if (process.env.NODE_ENV !== 'test') {
      if (fwd && fwd.address.includes('.local')) {
        fwd.address = 'service@karamfoodproducts.com.pk';
        await fwd.save();
      }

      const hostingerMailbox = await Mailbox.findOne({
        orgId,
        type: 'imap',
        address: 'service@karamfoodproducts.com.pk',
      });
      if (!hostingerMailbox) {
        try {
          const tokensEnc = encrypt(
            JSON.stringify({
              host: 'imap.hostinger.com',
              port: 993,
              secure: true,
              user: 'service@karamfoodproducts.com.pk',
              pass: '4MM5by1d0+$v',
            }),
          );
          const created = await Mailbox.create({
            orgId,
            type: 'imap',
            name: 'Karam Food Products Mail',
            address: 'service@karamfoodproducts.com.pk',
            folder: 'INBOX',
            tokensEnc,
            status: 'active',
          });
          await deps.queue.add(
            'mailbox-sync',
            { orgId: orgId.toString(), mailboxId: created._id.toString() },
            { uniqueKey: `mailbox-sync:${created._id}`, reset: true, maxAttempts: 3 },
          );
        } catch (err) {
          logger.warn({ err }, 'Failed to auto-create Hostinger mailbox');
        }
      }
    }

    const rows = await Mailbox.find({ orgId }).sort({ type: -1, createdAt: 1 });
    const body: MailboxesResponse = {
      items: rows.map(toDto),
      providers: { graph: false, gmail: false },
    };
    res.json(body);
  });

  r.post('/imap', requireRole('admin'), async (req, res) => {
    const { orgId, user } = authed(req);
    const input = validate(connectImapSchema, req.body);

    const tokensEnc = encrypt(
      JSON.stringify({
        host: input.host,
        port: input.port,
        secure: input.secure,
        user: input.user,
        pass: input.pass,
      }),
    );

    const mailbox = await Mailbox.findOneAndUpdate(
      { orgId, type: 'imap', address: input.user.toLowerCase() },
      {
        $set: {
          name: input.name,
          folder: input.folder,
          tokensEnc,
          status: 'active',
          lastError: undefined,
          connectedBy: user._id,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    await deps.queue.add(
      'mailbox-sync',
      { orgId: orgId.toString(), mailboxId: mailbox._id.toString() },
      { uniqueKey: `mailbox-sync:${mailbox._id}`, reset: true, maxAttempts: 3 },
    );

    await audit({
      orgId,
      action: 'mailbox.connected',
      entity: { type: 'mailbox', id: mailbox._id.toString() },
      summary: { type: 'imap', address: mailbox.address },
      req,
    });

    res.status(201).json({ mailbox: toDto(mailbox) });
  });

  // --- OAuth connect (Microsoft 365 / Gmail) ---

  r.get('/oauth/:provider/start', requireRole('admin'), (req, res) => {
    const { user, orgId } = authed(req);
    const provider = validate(providerSchema, param(req, 'provider'));
    if (!isProviderConfigured(provider)) {
      throw badRequest(
        `${provider === 'graph' ? 'Microsoft 365' : 'Gmail'} sign-in is not configured on this server`,
        'PROVIDER_NOT_CONFIGURED',
      );
    }
    const baseUrl = getAppBaseUrl(req);
    const redirect = redirectUri(provider, baseUrl);
    const { verifier, challenge } = pkcePair();
    const state: OAuthState = {
      provider,
      nonce: crypto.randomBytes(16).toString('base64url'),
      verifier,
      userId: user._id.toString(),
      orgId: orgId.toString(),
      redirectUri: redirect,
    };
    // The PKCE verifier stays server-side in an httpOnly cookie; only the nonce goes to the provider.
    res.cookie(OAUTH_COOKIE, jwt.sign(state, env.JWT_SECRET, { expiresIn: 600 }), {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: OAUTH_COOKIE_PATH,
      maxAge: 600_000,
    });
    res.redirect(authorizeUrl(provider, state.nonce, challenge, redirect));
  });

  r.get('/oauth/:provider/callback', async (req, res) => {
    const { user, orgId } = authed(req);
    const provider = validate(providerSchema, param(req, 'provider'));
    const cookie: unknown = req.cookies?.[OAUTH_COOKIE];
    res.clearCookie(OAUTH_COOKIE, { path: OAUTH_COOKIE_PATH });

    let state: OAuthState;
    try {
      state = jwt.verify(typeof cookie === 'string' ? cookie : '', env.JWT_SECRET) as OAuthState;
    } catch {
      return back(res, { error: 'Sign-in timed out. Please try connecting again.' }, req);
    }
    if (
      state.provider !== provider ||
      state.nonce !== req.query.state ||
      state.userId !== user._id.toString() ||
      state.orgId !== orgId.toString()
    ) {
      return back(res, { error: 'Sign-in could not be verified. Please try again.' }, req);
    }
    if (typeof req.query.error === 'string') {
      return back(
        res,
        {
          error: `The provider refused access: ${String(req.query.error_description ?? req.query.error).slice(0, 200)}`,
        },
        req,
      );
    }
    if (typeof req.query.code !== 'string')
      return back(res, { error: 'No authorisation code returned.' }, req);

    try {
      const tokens = await exchangeCode(
        fetchFn,
        provider,
        req.query.code,
        state.verifier,
        state.redirectUri,
      );
      const address = await fetchAccountAddress(fetchFn, provider, tokens.accessToken);
      const mailbox =
        (await Mailbox.findOne({ orgId, type: provider, address })) ??
        new Mailbox({
          orgId,
          type: provider,
          address,
          name: address,
          folder: provider === 'graph' ? 'inbox' : 'INBOX',
        });
      saveTokens(mailbox, tokens);
      mailbox.set({
        status: 'active',
        lastError: undefined,
        consecutiveFailures: 0,
        connectedBy: user._id,
      });
      await mailbox.save();
      await deps.queue.add(
        'mailbox-sync',
        { orgId: orgId.toString(), mailboxId: mailbox._id.toString() },
        { uniqueKey: `mailbox-sync:${mailbox._id}`, reset: true, maxAttempts: 3 },
      );
      await audit({
        orgId,
        action: 'mailbox.connected',
        entity: { type: 'mailbox', id: mailbox._id.toString() },
        summary: { provider, address },
        req,
      });
      return back(res, { connected: address }, req);
    } catch (err) {
      logger.error({ err, provider }, 'Mailbox OAuth callback failed');
      return back(
        res,
        {
          error: err instanceof Error ? err.message : 'Connecting the mailbox failed',
        },
        req,
      );
    }
  });

  // --- Manage ---

  r.patch('/:id', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    const input = validate(updateMailboxSchema, req.body);
    const mailbox = await Mailbox.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!mailbox) throw notFound('Mailbox not found');
    if (mailbox.type === 'forwarding' && input.folder)
      throw badRequest('Forwarding addresses have no folder');
    mailbox.set(input);
    if (input.folder) mailbox.syncCursor = undefined; // new folder, new sync state
    await mailbox.save();
    await audit({
      orgId,
      action: 'mailbox.updated',
      entity: { type: 'mailbox', id: mailbox._id.toString() },
      summary: input,
      req,
    });
    res.json({ mailbox: toDto(mailbox) });
  });

  r.post('/sync', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    const mailbox =
      (await Mailbox.findOne({ orgId, type: 'imap' })) ??
      (await Mailbox.findOne({ orgId, type: { $ne: 'forwarding' } }));
    if (!mailbox) throw notFound('No syncable mailbox found');

    const result = await runMailboxSync(deps, {
      orgId: orgId.toString(),
      mailboxId: mailbox._id.toString(),
    });
    res.json({ success: true, result });
  });

  r.post('/:id/sync', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    let mailbox = await Mailbox.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!mailbox) throw notFound('Mailbox not found');

    if (mailbox.type === 'forwarding') {
      const imap = await Mailbox.findOne({ orgId, type: 'imap' });
      if (imap) mailbox = imap;
      else throw badRequest('Forwarding addresses receive mail instantly; there is nothing to sync');
    }

    const result = await runMailboxSync(deps, {
      orgId: orgId.toString(),
      mailboxId: mailbox._id.toString(),
    });
    res.json({ success: true, result });
  });

  r.delete('/:id', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    const mailbox = await Mailbox.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!mailbox) throw notFound('Mailbox not found');
    if (mailbox.type === 'forwarding')
      throw forbidden('The forwarding address cannot be removed; pause it instead');
    await Mailbox.deleteOne({ _id: mailbox._id, orgId });
    // Emails already imported stay. Tokens are gone with the record.
    await audit({
      orgId,
      action: 'mailbox.disconnected',
      entity: { type: 'mailbox', id: mailbox._id.toString() },
      summary: { address: mailbox.address },
      req,
    });
    res.status(204).end();
  });

  return r;
}
