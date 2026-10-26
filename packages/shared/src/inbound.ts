import { z } from 'zod';

export const EMAIL_CLASSIFICATIONS = [
  'new_order',
  'amendment',
  'cancellation',
  'quote_request',
  'delivery_query',
  'not_order',
] as const;
export const emailClassificationSchema = z.enum(EMAIL_CLASSIFICATIONS);
export type EmailClassification = z.infer<typeof emailClassificationSchema>;

export const CLASSIFICATION_LABELS: Record<EmailClassification, string> = {
  new_order: 'New order',
  amendment: 'Amendment',
  cancellation: 'Cancellation',
  quote_request: 'Quote request',
  delivery_query: 'Delivery query',
  not_order: 'Not an order',
};

export type EmailSource = 'forwarding' | 'upload' | 'graph' | 'gmail';
export type EmailStatus = 'received' | 'parsed' | 'classified' | 'failed';

export type AttachmentDto = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: 'pdf' | 'image' | 'spreadsheet' | 'csv' | 'email' | 'document' | 'other';
  isInline: boolean;
  /** Short-lived signed URL to view the file. */
  url: string;
};

export type ClassificationDto = {
  label: EmailClassification;
  confidence: number;
  method: 'heuristic' | 'llm' | 'manual';
  reasons: string[];
  model: string | null;
  classifiedAt: string;
  classifiedBy: string | null;
};

export type EmailListItemDto = {
  id: string;
  source: EmailSource;
  status: EmailStatus;
  from: { name: string | null; address: string | null };
  subject: string;
  snippet: string;
  receivedAt: string;
  attachmentCount: number;
  classification: ClassificationDto | null;
  error: string | null;
};

export type EmailDetailDto = EmailListItemDto & {
  to: string[];
  cc: string[];
  text: string;
  /** Sanitised HTML, safe to render in a sandboxed iframe. */
  html: string | null;
  messageId: string | null;
  mailbox: { id: string; type: string; address: string } | null;
  attachments: AttachmentDto[];
  rawUrl: string;
  timeline: { at: string; event: string; detail?: string }[];
};

export const reclassifySchema = z.object({ label: emailClassificationSchema });

export type MailboxType = 'forwarding' | 'graph' | 'gmail';

export type MailboxDto = {
  id: string;
  type: MailboxType;
  name: string;
  address: string;
  status: 'active' | 'error' | 'disconnected' | 'paused';
  folder: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
};

export type MailboxesResponse = {
  items: MailboxDto[];
  providers: { graph: boolean; gmail: boolean };
};

export const updateMailboxSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    folder: z.string().trim().min(1).max(200),
    status: z.enum(['active', 'paused']),
  })
  .partial();

export type ProcessingErrorDto = {
  id: string;
  jobName: string;
  entity: { type: string; id: string } | null;
  message: string;
  attempts: number;
  status: 'open' | 'retried' | 'dismissed';
  createdAt: string;
};
