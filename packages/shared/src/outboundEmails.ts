import { z } from 'zod';

export const OUTBOUND_EMAIL_TYPES = ['acknowledgment', 'clarification', 'custom'] as const;
export type OutboundEmailType = (typeof OUTBOUND_EMAIL_TYPES)[number];

export const OUTBOUND_EMAIL_STATUSES = ['draft', 'sending', 'sent', 'failed'] as const;
export type OutboundEmailStatus = (typeof OUTBOUND_EMAIL_STATUSES)[number];

export type OutboundEmailDto = {
  id: string;
  orderId: string;
  type: OutboundEmailType;
  to: string;
  subject: string;
  body: string;
  status: OutboundEmailStatus;
  sentAt: string | null;
  sentBy: { id: string; name: string } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export const createDraftSchema = z.object({
  type: z.enum(OUTBOUND_EMAIL_TYPES),
  to: z.string().trim().email().optional(),
  subject: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(10000).optional(),
});
export type CreateDraftInput = z.infer<typeof createDraftSchema>;

export const updateDraftSchema = z.object({
  to: z.string().trim().email().optional(),
  subject: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(10000).optional(),
});
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;
