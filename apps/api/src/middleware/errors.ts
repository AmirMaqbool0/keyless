import type { ErrorRequestHandler, RequestHandler } from 'express';
import { MulterError } from 'multer';
import type { ApiErrorBody } from '@keyless/shared';
import { AppError } from '@keyless/core/lib/http';
import { logger } from '@keyless/core/lib/logger';

export const notFoundHandler: RequestHandler = (_req, res) => {
  const body: ApiErrorBody = { error: { code: 'NOT_FOUND', message: 'Route not found' } };
  res.status(404).json(body);
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof AppError) {
    const body: ApiErrorBody = {
      error: { code: err.code, message: err.message, details: err.details },
    };
    res.status(err.status).json(body);
    return;
  }
  // Malformed JSON from express.json()
  if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
    return;
  }
  // Upload limits (file too big, too many files)
  if (err instanceof MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (25 MB max)' : err.message;
    res.status(400).json({ error: { code: 'UPLOAD_ERROR', message } });
    return;
  }
  // Mongo duplicate key
  if (typeof err === 'object' && err !== null && 'code' in err && err.code === 11000) {
    const keyPattern = (err as { keyPattern?: Record<string, number> }).keyPattern ?? {};
    let message = 'That record already exists';
    if ('email' in keyPattern) {
      message = 'An account with this email already exists';
    } else if ('slug' in keyPattern) {
      message = 'An organisation with this name already exists';
    }
    logger.warn({ err, reqId: req.id, keyPattern }, 'Handled duplicate key conflict');
    res.status(409).json({ error: { code: 'DUPLICATE', message } });
    return;
  }
  logger.error({ err, reqId: req.id }, 'Unhandled error');
  const body: ApiErrorBody = { error: { code: 'INTERNAL', message: 'Something went wrong' } };
  res.status(500).json(body);
};
