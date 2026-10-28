import type { Types } from 'mongoose';
import { logger } from '../lib/logger';
import type { Storage } from '../lib/storage';
import { Attachment } from '../models/Attachment';
import { InboundEmail } from '../models/InboundEmail';
import { Organization } from '../models/Organization';

export type PruneResult = {
  orgId: string;
  emailsPruned: number;
  attachmentsPruned: number;
};

/**
 * Prunes raw email bodies, headers, and attachments older than the organization's retention setting,
 * while leaving Order records and aggregated analytics completely intact for GDPR compliance.
 */
export async function pruneExpiredTenantData(
  deps: { storage?: Storage },
  orgId: Types.ObjectId,
  overrideDays?: number,
): Promise<PruneResult> {
  const org = await Organization.findById(orgId);
  if (!org) return { orgId: orgId.toString(), emailsPruned: 0, attachmentsPruned: 0 };

  const retentionDays = overrideDays ?? org.settings.retentionDays ?? 90;
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // Find emails older than cutoff date that have not already had their raw text wiped
  const emails = await InboundEmail.find({
    orgId,
    receivedAt: { $lt: cutoffDate },
    rawStorageKey: { $ne: '[deleted]' },
  });

  let emailsPruned = 0;
  let attachmentsPruned = 0;

  for (const email of emails) {
    // 1. Delete raw email file from storage
    if (deps.storage && email.rawStorageKey && email.rawStorageKey !== '[deleted]') {
      try {
        await deps.storage.delete(email.rawStorageKey);
      } catch (err) {
        logger.warn({ err, key: email.rawStorageKey }, 'Failed to delete raw email storage file during prune');
      }
    }

    // 2. Delete all attachments associated with this email
    const attachments = await Attachment.find({ _id: { $in: email.attachmentIds }, orgId });
    for (const att of attachments) {
      if (deps.storage && att.storageKey) {
        try {
          await deps.storage.delete(att.storageKey);
        } catch (err) {
          logger.warn({ err, key: att.storageKey }, 'Failed to delete attachment storage file during prune');
        }
      }
      attachmentsPruned++;
    }

    // 3. Wipe raw body, html, headers, and mark storage key cleared
    email.text = '[Raw email body deleted per data retention policy]';
    email.html = undefined;
    email.headers = {};
    email.rawStorageKey = '[deleted]';
    await email.save();

    emailsPruned++;
  }

  logger.info(
    { orgId, retentionDays, emailsPruned, attachmentsPruned },
    'Completed data retention cleanup for organization',
  );

  return {
    orgId: orgId.toString(),
    emailsPruned,
    attachmentsPruned,
  };
}
