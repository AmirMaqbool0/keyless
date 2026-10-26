import type { Request } from 'express';
import type { Types } from 'mongoose';
import { AuditLog } from '../models/AuditLog';
import { logger } from './logger';

type AuditInput = {
  orgId: Types.ObjectId | string;
  action: string;
  entity: { type: string; id?: string };
  summary?: Record<string, unknown>;
  /** Defaults to the authenticated user on `req`. */
  actor?: {
    userId?: Types.ObjectId | string;
    email?: string;
    type: 'user' | 'system' | 'superadmin';
  };
  req?: Request;
};

/** Write an audit entry. Never throws: a failed audit write is logged, not fatal to the request. */
export async function audit(input: AuditInput): Promise<void> {
  const actor =
    input.actor ??
    (input.req?.auth
      ? { userId: input.req.auth.user._id, email: input.req.auth.user.email, type: 'user' as const }
      : { type: 'system' as const });
  try {
    await AuditLog.create({
      orgId: input.orgId,
      actor,
      action: input.action,
      entity: input.entity,
      summary: input.summary,
      ip: input.req?.ip,
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'Failed to write audit log');
  }
}
