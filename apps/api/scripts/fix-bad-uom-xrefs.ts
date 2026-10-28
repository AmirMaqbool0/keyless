/**
 * Data cleanup script to:
 * 1. Fix learned CrossReferences with bad uomFactor (reset to 1).
 * 2. Remove public domains (gmail.com) and test senders (amirmaqbool055@gmail.com) from customers.
 *
 * Runs in dry-run mode by default.
 * Apply changes with:
 *   pnpm --filter @keyless/api exec tsx scripts/fix-bad-uom-xrefs.ts --apply
 */
import { env } from '@keyless/core/config/env';
import { connectDb, disconnectDb } from '@keyless/core/db/connect';
import { CrossReference } from '@keyless/core/models/CrossReference';
import { Customer } from '@keyless/core/models/Customer';
import { Organization } from '@keyless/core/models/Organization';
import { Product } from '@keyless/core/models/Product';
import { isPublicDomain } from '@keyless/core/matching/catalogue';
import { extractPackSize, areUomEqual } from '@keyless/shared';

async function main(): Promise<void> {
  const isApply = process.argv.includes('--apply');
  console.log(`Running cleanup in ${isApply ? 'APPLY' : 'DRY-RUN'} mode...\n`);

  await connectDb(env.MONGO_URI);

  try {
    const orgs = await Organization.find();
    console.log(`Found ${orgs.length} organization(s).\n`);

    let totalFixedXrefs = 0;
    let totalFixedCustomers = 0;

    for (const org of orgs) {
      console.log(`--- Processing Org: ${org.name} (${org._id}) ---`);

      // 1. CrossReference uomFactor cleanup
      const xrefs = await CrossReference.find({
        orgId: org._id,
        uomFactor: { $ne: 1 },
        source: 'learned',
      });

      console.log(`Found ${xrefs.length} learned CrossReference records with uomFactor != 1.`);

      for (const xref of xrefs) {
        const product = await Product.findOne({
          orgId: org._id,
          $or: [{ _id: xref.productId }, { sku: xref.sku }],
        });

        if (!product) {
          console.log(`Xref ${xref._id} (SKU: ${xref.sku}): product not found.`);
          continue;
        }

        const custPackSize = extractPackSize(xref.customerDescription);
        const prodPackSize = extractPackSize(product.description);
        const samePack =
          custPackSize !== null && prodPackSize !== null && custPackSize === prodPackSize;
        const sameUom = areUomEqual(xref.customerUom, product.uom);

        // Also check if customer is Abbey Cafe / SKU GL1459 specifically or general match
        if (samePack || sameUom || xref.sku === 'GL1459') {
          console.log(
            `[XREF MATCH] Xref ${xref._id} | SKU: ${xref.sku} | Current factor: ${xref.uomFactor} | Reason: ${
              samePack
                ? `both pack size ${custPackSize}`
                : sameUom
                  ? `same UOM ${xref.customerUom}`
                  : 'GL1459 candidate'
            }`,
          );

          if (isApply) {
            xref.uomFactor = 1;
            await xref.save();
            console.log(`   -> RESET to uomFactor: 1 (APPLIED)`);
          } else {
            console.log(`   -> [DRY-RUN] Would reset uomFactor to 1`);
          }
          totalFixedXrefs++;
        }
      }

      // 2. Customer domain and sender cleanup (Abbey Cafe, Abbey Bistro, and all customers)
      const customers = await Customer.find({ orgId: org._id });
      for (const cust of customers) {
        let changed = false;

        // Clean emailDomains
        const originalDomains = [...cust.emailDomains];
        const cleanedDomains = cust.emailDomains.filter(
          (d) => d.toLowerCase() !== 'gmail.com' && !isPublicDomain(d),
        );
        if (cleanedDomains.length !== originalDomains.length) {
          const removed = originalDomains.filter((d) => !cleanedDomains.includes(d));
          console.log(
            `[CUSTOMER DOMAINS] ${cust.name} (${cust.accountCode}): removing domain(s): ${removed.join(', ')}`,
          );
          cust.emailDomains = cleanedDomains;
          changed = true;
        }

        // Clean senderAddresses
        const originalSenders = [...cust.senderAddresses];
        const cleanedSenders = cust.senderAddresses.filter(
          (s) =>
            s.toLowerCase() !== 'amirmaqbool055@gmail.com' &&
            // Also clean if Abbey Cafe or Abbey Bistro has public gmail
            !((cust.accountCode === 'ABBE001' || cust.accountCode === 'ABBE002') && s.toLowerCase().endsWith('@gmail.com')),
        );
        if (cleanedSenders.length !== originalSenders.length) {
          const removed = originalSenders.filter((s) => !cleanedSenders.includes(s));
          console.log(
            `[CUSTOMER SENDERS] ${cust.name} (${cust.accountCode}): removing sender(s): ${removed.join(', ')}`,
          );
          cust.senderAddresses = cleanedSenders;
          changed = true;
        }

        if (changed) {
          if (isApply) {
            await cust.save();
            console.log(`   -> [APPLIED] Customer ${cust.name} updated.`);
          } else {
            console.log(`   -> [DRY-RUN] Would update customer ${cust.name}.`);
          }
          totalFixedCustomers++;
        }
      }

      console.log('');
    }

    console.log(
      `Finished. ${totalFixedXrefs} xref(s) and ${totalFixedCustomers} customer(s) processed. (${
        isApply ? 'APPLIED TO DATABASE' : 'DRY-RUN (run with --apply to execute)'
      })`,
    );
  } finally {
    await disconnectDb();
  }
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
