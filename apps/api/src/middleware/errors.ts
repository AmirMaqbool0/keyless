import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ApiErrorBody } from '@keyless/shared';
import { AppError } from '../lib/http';
import { logger } from '../lib/logger';

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
  // Mongo duplicate key
  if (typeof err === 'object' && err !== null && 'code' in err && err.code === 11000) {
    res.status(409).json({ error: { code: 'DUPLICATE', message: 'That record already exists' } });
    return;
  }
  logger.error({ err, reqId: req.id }, 'Unhandled error');
  const body: ApiErrorBody = { error: { code: 'INTERNAL', message: 'Something went wrong' } };
  res.status(500).json(body);
};
