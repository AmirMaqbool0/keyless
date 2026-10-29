import { z } from 'zod';
import type { ExtractionDto } from './extraction';
import type { OrderStatus, RouteColour } from './orders';

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

export type EmailSource = 'forwarding' | 'upload' | 'graph' | 'gmail' | 'imap';
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
  extraction: {
    status: 'running' | 'completed' | 'partial' | 'failed' | 'needs_llm';
    orderCount: number;
    lineCount: number;
    issueCount: number;
  } | null;
};

export type EmailDetailDto = EmailListItemDto & {
  to: string[];
  cc: string[];
  text: string;
  /** HTML as received. Only render it in a sandboxed iframe with a restrictive CSP. */
  html: string | null;
  messageId: string | null;
  mailbox: { id: string; type: string; address: string } | null;
  attachments: AttachmentDto[];
  rawUrl: string;
  timeline: { at: string; event: string; detail?: string }[];
  extractions: ExtractionDto[];
  /** Orders created from this email, and existing orders it amends or cancels. */
  orders: {
    id: string;
    poNumber: string | null;
    status: OrderStatus;
    colour: RouteColour;
    relation: 'created' | 'changes';
  }[];
};

export const reclassifySchema = z.object({ label: emailClassificationSchema });

export type MailboxType = 'forwarding' | 'graph' | 'gmail' | 'imap';

export const connectImapSchema = z.object({
  name: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().trim().email(),
  pass: z.string().min(1),
  folder: z.string().trim().default('INBOX'),
});
export type ConnectImapDto = z.infer<typeof connectImapSchema>;

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
