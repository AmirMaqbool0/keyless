import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import type { AttachmentDto } from '@keyless/shared';
import { tenantScoped } from '../db/tenant';

export type AttachmentKind = AttachmentDto['kind'];

export interface IAttachment {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  emailId: Types.ObjectId;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  storageKey: string;
  kind: AttachmentKind;
  /** Embedded in the HTML body (logos, signatures). Usually not an order document. */
  isInline: boolean;
  contentId?: string;
  /** Filled by extraction (M4). */
  pageCount?: number;
  parsedText?: string;
  createdAt: Date;
}

const attachmentSchema = new Schema<IAttachment>(
  {
    emailId: { type: Schema.Types.ObjectId, ref: 'InboundEmail', required: true },
    filename: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    storageKey: { type: String, required: true },
    kind: {
      type: String,
      enum: ['pdf', 'image', 'spreadsheet', 'csv', 'email', 'document', 'other'],
      required: true,
    },
    isInline: { type: Boolean, default: false },
    contentId: String,
    pageCount: Number,
    parsedText: String,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
attachmentSchema.plugin(tenantScoped);
attachmentSchema.index({ orgId: 1, emailId: 1 });

export const Attachment = model<IAttachment>('Attachment', attachmentSchema);
export type AttachmentDoc = HydratedDocument<IAttachment>;

/** What we will do with a file, from its MIME type and extension. */
export function attachmentKind(filename: string, mimeType: string): AttachmentKind {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const mime = mimeType.toLowerCase();
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (
    mime.startsWith('image/') ||
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'tif', 'tiff'].includes(ext)
  )
    return 'image';
  if (ext === 'csv' || mime === 'text/csv') return 'csv';
  if (
    ['xlsx', 'xls', 'xlsm', 'ods'].includes(ext) ||
    mime.includes('spreadsheet') ||
    mime.includes('ms-excel')
  )
    return 'spreadsheet';
  if (ext === 'eml' || mime === 'message/rfc822') return 'email';
  if (['doc', 'docx', 'odt', 'rtf', 'txt'].includes(ext) || mime.includes('word'))
    return 'document';
  return 'other';
}
