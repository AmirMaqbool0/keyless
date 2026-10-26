/**
 * Writes sample CSVs (as a distributor's ERP might export them) to /samples for trying the
 * import flow: 5,000 products, 60 customers, prices and cross-references.
 * Usage: pnpm --filter @keyless/api samples
 */
import fs from 'node:fs';
import path from 'node:path';
import Papa from 'papaparse';
import { generateDemoData } from '@keyless/core/demo/generator';

const outDir = path.resolve(process.cwd(), '../../samples');
fs.mkdirSync(outDir, { recursive: true });
const data = generateDemoData();

// Deliberately not Keyless's own field names: the import should auto-map typical ERP headers.
const files: Record<string, Record<string, unknown>[]> = {
  'products.csv': data.products.map((p) => ({
    'Stock Code': p.sku,
    Description: p.description,
    Unit: p.uom,
    'Pack Qty': p.packSize,
    EAN: p.barcode,
    'Sell Price': p.defaultPrice.toFixed(2),
    'Free Stock': p.stockQty,
    Active: p.active ? 'Yes' : 'No',
  })),
  // One row per delivery address, as many ERPs export them.
  'customers.csv': data.customers.flatMap((c) =>
    c.deliveryAddresses.map((a) => ({
      'Account Code': c.accountCode,
      'Customer Name': c.name,
      'Order Email': c.senderAddresses.join('; '),
      'Email Domain': c.emailDomains.join('; '),
      'Price List': c.priceListCode ?? '',
      'On Stop': c.creditHold ? 'Y' : 'N',
      'Address 1': a.line1,
      'Address 2': a.line2 ?? '',
      Town: a.city,
      Postcode: a.postcode,
      Country: a.country,
    })),
  ),
  'prices.csv': data.prices.map((p) => ({
    'Account Code': p.accountCode ?? '',
    'Price List': p.priceListCode ?? '',
    'Stock Code': p.sku,
    'Net Price': p.price.toFixed(2),
    Currency: p.currency,
    'Min Qty': p.minQty ?? '',
  })),
  'cross-references.csv': data.crossReferences.map((x) => ({
    'Account Code': x.accountCode,
    'Customer Part Code': x.customerPartCode ?? '',
    'Customer Description': x.customerDescription ?? '',
    'Our SKU': x.sku,
    'Customer UOM': x.customerUom ?? '',
    Factor: x.uomFactor === undefined ? '' : Number(x.uomFactor.toFixed(6)),
  })),
};

for (const [name, rows] of Object.entries(files)) {
  fs.writeFileSync(path.join(outDir, name), Papa.unparse(rows, { newline: '\r\n' }));
  console.log(`${name.padEnd(22)} ${rows.length.toLocaleString()} rows`);
}
console.log(`\nWritten to ${outDir}`);
