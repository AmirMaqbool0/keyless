import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { SAMPLE_SCENARIOS, sampleEmail, type SampleContext } from '@keyless/core/demo/sampleEmails';
import {
  ensureForwardingMailbox,
  receiveRawEmail,
  type IngestDeps,
} from '@keyless/core/ingestion/receive';
import { validate } from '@keyless/core/lib/http';
import { CrossReference } from '@keyless/core/models/CrossReference';
import { Customer } from '@keyless/core/models/Customer';
import { Product } from '@keyless/core/models/Product';
import type { OrganizationDoc } from '@keyless/core/models/Organization';
import { authed, requireRole } from '../../middleware/auth';

const bodySchema = z.object({ scenario: z.enum(SAMPLE_SCENARIOS).default('pdf_po') });

/** Build a context from the org's real customers and catalogue when it has them. */
async function sampleContext(org: OrganizationDoc, to: string): Promise<SampleContext> {
  const orgId = org._id;
  const [customer] = await Customer.aggregate<{
    _id: unknown;
    name: string;
    senderAddresses: string[];
    deliveryAddresses: { line1: string; city?: string; postcode?: string }[];
  }>([{ $match: { orgId, 'senderAddresses.0': { $exists: true } } }, { $sample: { size: 1 } }]);
  const xrefs = customer
    ? await CrossReference.find({
        orgId,
        customerId: customer._id,
        customerPartCode: { $exists: true },
      })
        .limit(3)
        .lean()
    : [];
  const products = await Product.aggregate<{
    sku: string;
    description: string;
    defaultPrice?: number;
  }>([{ $match: { orgId, active: true } }, { $sample: { size: 4 - Math.min(xrefs.length, 2) } }]);
  const lines = [
    ...xrefs
      .slice(0, 2)
      .map((x) => ({
        code: x.customerPartCode!,
        description: x.customerDescription ?? 'As per your catalogue',
        quantity: 2 + crypto.randomInt(10),
      })),
    ...products.map((p) => ({
      code: p.sku,
      description: p.description,
      quantity: 1 + crypto.randomInt(12),
      unitPrice: p.defaultPrice,
    })),
  ];
  const address = customer?.deliveryAddresses[0];
  return {
    customerName: customer?.name ?? 'Example Cafe Ltd',
    senderName: 'Sam Buyer',
    senderAddress: customer?.senderAddresses[0] ?? 'orders@example-cafe.example',
    to,
    poNumber: `PO-${100000 + crypto.randomInt(900000)}`,
    deliveryAddress: address
      ? [address.line1, address.city ?? '', address.postcode ?? ''].filter(Boolean)
      : ['1 High Street', 'Leeds', 'LS1 4AB'],
    lines: lines.length
      ? lines
      : [
          {
            code: 'GL1001',
            description: 'Nitrile Gloves Blue Medium (Box 100)',
            quantity: 10,
            unitPrice: 4.5,
          },
        ],
  };
}

/** Development only: send a realistic email to this org's forwarding address. */
export function devTestEmailRouter(deps: IngestDeps): Router {
  const r = Router();
  r.post('/test-email', requireRole('reviewer'), async (req, res) => {
    const { org } = authed(req);
    const { scenario } = validate(bodySchema, req.body);
    const mailbox = await ensureForwardingMailbox(org);
    const raw = await sampleEmail(scenario, await sampleContext(org, mailbox.address));
    const { email } = await receiveRawEmail(deps, {
      orgId: org._id,
      mailboxId: mailbox._id,
      source: 'forwarding',
      raw,
    });
    res.status(201).json({ emailId: email._id.toString(), scenario });
  });
  return r;
}
