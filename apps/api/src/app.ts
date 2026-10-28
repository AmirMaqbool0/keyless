import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env, isProd } from '@keyless/core/config/env';
import { dbReady } from '@keyless/core/db/connect';
import { logger } from '@keyless/core/lib/logger';
import { ConsoleMailer, type Mailer } from '@keyless/core/lib/mailer';
import { authenticate, requireAuth, requireVerified } from './middleware/auth';
import { csrf } from './middleware/csrf';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { apiLimiter } from './middleware/rateLimit';
import { auditRouter } from './modules/audit/routes';
import { authRouter } from './modules/auth/routes';
import { devRouter } from './modules/dev/routes';
import { orgRouter } from './modules/org/routes';
import { usersRouter } from './modules/users/routes';
import { catalogueRouter } from './modules/catalogue/routes';
import { connectorsRouter } from './modules/connectors/routes';
import { rulesRouter } from './modules/rules/routes';
import { analyticsRouter } from './modules/analytics/routes';
import { billingRouter } from './modules/billing/routes';
import { importsRouter } from './modules/imports/routes';
import { devTestEmailRouter } from './modules/dev/testEmail';
import { emailsRouter, processingErrorsRouter } from './modules/inbound/emails';
import { filesRouter } from './modules/inbound/files';
import { mailboxesRouter } from './modules/inbound/mailboxes';
import { ordersRouter } from './modules/orders/routes';
import { inboundWebhookRouter } from './modules/inbound/webhook';
import { superAdminRouter } from './modules/superadmin/routes';
import type { Storage } from '@keyless/core/lib/storage';
import type { FetchLike } from '@keyless/core/mailboxes/oauth';
import type { JobQueue } from '@keyless/core/queue/types';

export type AppDeps = {
  mailer: Mailer;
  storage: Storage;
  queue: JobQueue;
  /** Injected in tests to fake Microsoft/Google HTTP calls. */
  fetch?: FetchLike;
};

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind one reverse proxy in production, so req.ip is the client address.
  app.set('trust proxy', isProd ? 1 : false);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && incoming.length <= 100 ? incoming : crypto.randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') ?? false },
    }),
  );
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors({ origin: env.APP_URL, credentials: true }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', (_req, res) => {
    const ready = dbReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', db: ready });
  });

  // Provider webhooks: before CSRF and JSON parsing; they authenticate with their own secret.
  app.use('/webhooks/inbound', inboundWebhookRouter(deps));
  const bRouter = billingRouter();
  app.use('/webhooks/stripe', express.json(), (req, res, next) => {
    req.url = '/webhook';
    bRouter(req, res, next);
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use('/api', apiLimiter, csrf, authenticate);

  if (!isProd && deps.mailer instanceof ConsoleMailer) {
    app.use('/api/dev', devRouter({ mailer: deps.mailer }));
  }
  app.use('/api/auth', authRouter(deps));
  // Signed, expiring links: the signature is the authorisation.
  app.use('/api/files', filesRouter(deps));

  // Everything below needs a signed-in, verified user.
  app.use('/api', requireAuth, requireVerified);
  app.use('/api/users', usersRouter(deps));
  app.use('/api/org', orgRouter({ storage: deps.storage }));
  app.use('/api/superadmin', superAdminRouter(deps));
  app.use('/api/audit', auditRouter());
  app.use('/api/imports', importsRouter(deps));
  app.use('/api/connectors', connectorsRouter(deps));
  app.use('/api/rules', rulesRouter());
  app.use('/api/analytics', analyticsRouter());
  app.use('/api/billing', bRouter);
  app.use('/api/emails', emailsRouter(deps));
  app.use('/api/orders', ordersRouter(deps));
  app.use('/api/mailboxes', mailboxesRouter(deps));
  app.use('/api/processing-errors', processingErrorsRouter(deps));
  if (!isProd) app.use('/api/dev', devTestEmailRouter(deps));
  app.use('/api', catalogueRouter());

  // In production (or when built web assets are present), serve the frontend SPA
  const webDistCandidates = [
    path.resolve(process.cwd(), 'apps/web/dist'),
    path.resolve(process.cwd(), '../web/dist'),
    path.resolve(import.meta.dirname ?? '', '../../web/dist'),
  ];
  const webDist = webDistCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')));

  if (webDist) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (
        req.method !== 'GET' ||
        req.path.startsWith('/api') ||
        req.path.startsWith('/webhooks') ||
        req.path.startsWith('/health')
      ) {
        return next();
      }
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
