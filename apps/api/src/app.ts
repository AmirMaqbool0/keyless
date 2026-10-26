import crypto from 'node:crypto';
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
import { importsRouter } from './modules/imports/routes';
import type { Storage } from '@keyless/core/lib/storage';

export type AppDeps = { mailer: Mailer; storage: Storage };

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
  app.use(helmet());
  app.use(cors({ origin: env.APP_URL, credentials: true }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/health/ready', (_req, res) => {
    const ready = dbReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', db: ready });
  });

  // Provider webhooks (inbound email, Stripe) will be mounted here, before CSRF and JSON parsing.

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use('/api', apiLimiter, csrf, authenticate);

  if (!isProd && deps.mailer instanceof ConsoleMailer) {
    app.use('/api/dev', devRouter({ mailer: deps.mailer }));
  }
  app.use('/api/auth', authRouter(deps));

  // Everything below needs a signed-in, verified user.
  app.use('/api', requireAuth, requireVerified);
  app.use('/api/users', usersRouter(deps));
  app.use('/api/org', orgRouter());
  app.use('/api/audit', auditRouter());
  app.use('/api/imports', importsRouter(deps));
  app.use('/api/connectors', connectorsRouter());
  app.use('/api', catalogueRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
