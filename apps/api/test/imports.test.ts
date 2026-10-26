import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { generateDemoData } from '../src/demo/generator';
import { Customer } from '../src/models/Customer';
import { Product } from '../src/models/Product';
import { useTestApp } from './helpers';

const t = useTestApp();

async function adminClient() {
  const admin = await t.createUser({ role: 'admin' });
  return { admin, c: await t.loginAs(admin.email) };
}

type Client = Awaited<ReturnType<typeof adminClient>>['c'];

/** Upload, accept the suggested mapping (optionally overridden), commit. */
async function importCsv(
  c: Client,
  type: string,
  csv: string,
  mapping?: Record<string, string | null>,
) {
  const up = await c.upload('/api/imports', { type }, { name: `${type}.csv`, content: csv });
  expect(up.status).toBe(201);
  const res = await c.post(
    `/api/imports/${up.body.job.id}/commit`,
    mapping ? { mapping: { ...up.body.job.mapping, ...mapping } } : {},
  );
  expect(res.status).toBe(200);
  return res.body.job;
}

const PRODUCTS_CSV = [
  'Stock Code,Description,Unit,Pack Qty,EAN,Sell Price,Free Stock,Active',
  'GL1001,Nitrile Gloves Blue Medium (Box 100),BOX,100,5012345678900,"£4.50",120,Yes',
  'GL1002,Nitrile Gloves Blue Large (Box 100),BOX,100,,4.75,0,yes',
  'BAD1,Broken row,BOX,ten,,1,,',
  ',Missing code,BOX,1,,1,,',
  'CH2001,Thick Bleach 5L (Case 2),CASE,2,,"1,234.00",5,No',
].join('\n');

describe('product import', () => {
  it('suggests a mapping, reports row errors, and imports the valid rows', async () => {
    const { c, admin } = await adminClient();
    const up = await c.upload(
      '/api/imports',
      { type: 'products' },
      { name: 'stock.csv', content: PRODUCTS_CSV },
    );
    expect(up.status).toBe(201);
    const job = up.body.job;
    expect(job.mapping).toMatchObject({
      sku: 'Stock Code',
      description: 'Description',
      packSize: 'Pack Qty',
      defaultPrice: 'Sell Price',
      stockQty: 'Free Stock',
      active: 'Active',
    });
    expect(job.sampleRows).toHaveLength(5);

    const checked = await c.post(`/api/imports/${job.id}/validate`, {});
    expect(checked.body.job.status).toBe('validated');
    expect(checked.body.job.totals).toMatchObject({ rows: 5, valid: 3, skipped: 2 });
    expect(checked.body.job.errors).toEqual([
      { row: 4, field: 'packSize', message: 'Pack size: "ten" is not a number' },
      { row: 5, field: 'sku', message: 'SKU / product code is required' },
    ]);
    expect(await Product.countDocuments({ orgId: admin.orgId })).toBe(0); // validate is a dry run

    const done = await c.post(`/api/imports/${job.id}/commit`, {});
    expect(done.body.job).toMatchObject({
      status: 'completed',
      totals: { created: 3, updated: 0, skipped: 2 },
    });
    const bleach = await Product.findOne({ orgId: admin.orgId, skuKey: 'CH2001' });
    expect(bleach).toMatchObject({
      defaultPrice: 1234,
      active: false,
      packSize: 2,
      source: 'import',
    });

    // Already-run imports cannot be committed twice.
    expect((await c.post(`/api/imports/${job.id}/commit`, {})).status).toBe(409);
  });

  it('re-importing updates in place and never blanks fields missing from the file', async () => {
    const { c, admin } = await adminClient();
    await importCsv(c, 'products', PRODUCTS_CSV);
    const second = await importCsv(
      c,
      'products',
      'SKU,Description,Price\ngl1001,Nitrile Gloves Blue M (Box 100),4.99',
    );
    expect(second.totals).toMatchObject({ created: 0, updated: 1 });
    const gloves = await Product.findOne({ orgId: admin.orgId, skuKey: 'GL1001' });
    expect(gloves).toMatchObject({
      defaultPrice: 4.99,
      packSize: 100,
      barcode: '5012345678900',
      stockQty: 120,
    });
  });

  it('rejects mappings that skip required fields or reference missing columns', async () => {
    const { c } = await adminClient();
    const up = await c.upload(
      '/api/imports',
      { type: 'products' },
      { name: 'p.csv', content: PRODUCTS_CSV },
    );
    const noSku = await c.post(`/api/imports/${up.body.job.id}/validate`, {
      mapping: { ...up.body.job.mapping, sku: null },
    });
    expect(noSku.status).toBe(400);
    expect(noSku.body.error.message).toContain('SKU');
    const ghost = await c.post(`/api/imports/${up.body.job.id}/validate`, {
      mapping: { ...up.body.job.mapping, uom: 'Nope' },
    });
    expect(ghost.status).toBe(400);
  });

  it('rejects empty and non-CSV files, and non-admins', async () => {
    const { c, admin } = await adminClient();
    expect(
      (
        await c.upload(
          '/api/imports',
          { type: 'products' },
          { name: 'p.csv', content: 'SKU,Description\n' },
        )
      ).body.error.code,
    ).toBe('EMPTY_FILE');
    expect(
      (await c.upload('/api/imports', { type: 'products' }, { name: 'p.xlsx', content: 'x' })).body
        .error.code,
    ).toBe('UNSUPPORTED_FILE');
    expect(
      (await c.upload('/api/imports', { type: 'nope' }, { name: 'p.csv', content: 'a\n1' })).status,
    ).toBe(400);

    const reviewer = await t.createUser({ role: 'reviewer', orgId: admin.orgId });
    const rc = await t.loginAs(reviewer.email);
    expect(
      (
        await rc.upload(
          '/api/imports',
          { type: 'products' },
          { name: 'p.csv', content: PRODUCTS_CSV },
        )
      ).status,
    ).toBe(403);
    expect((await rc.get('/api/products')).status).toBe(200); // but can read the catalogue
  });

  it('imports a 5,000-product catalogue quickly and searches it fast', async () => {
    const { c } = await adminClient();
    const { products } = generateDemoData({ productCount: 5000 });
    const csv = Papa.unparse(
      products.map((p) => ({
        'Item Code': p.sku,
        Name: p.description,
        UOM: p.uom,
        'Pack Size': p.packSize,
        Barcode: p.barcode,
        Price: p.defaultPrice,
        Stock: p.stockQty,
      })),
    );

    const started = Date.now();
    const job = await importCsv(c, 'products', csv);
    const importMs = Date.now() - started;
    expect(job.totals).toMatchObject({ rows: 5000, created: 5000, errors: 0 });
    expect(importMs).toBeLessThan(15_000);

    const target = products.find((p) =>
      p.description.includes('Nitrile Gloves Powder Free Blue Medium'),
    )!;
    const searchStarted = Date.now();
    const res = await c.get('/api/products?q=nitrile%20blue%20medium&pageSize=50');
    const searchMs = Date.now() - searchStarted;
    expect(res.body.total).toBeGreaterThan(0);
    expect(
      res.body.items.every(
        (p: { description: string }) =>
          /nitrile/i.test(p.description) && /blue/i.test(p.description),
      ),
    ).toBe(true);
    expect(searchMs).toBeLessThan(500);

    const bySku = await c.get(`/api/products?q=${target.sku.toLowerCase()}`);
    expect(bySku.body.items[0].sku).toBe(target.sku);
    const byBarcode = await c.get(`/api/products?q=${target.barcode}`);
    expect(byBarcode.body.items[0].sku).toBe(target.sku);
    console.info(`5,000-product import: ${importMs} ms; search: ${searchMs} ms`);
  });
});

describe('customers, prices and cross-references', () => {
  it('merges one-row-per-address customer exports and links prices and cross-references', async () => {
    const { c, admin } = await adminClient();
    await importCsv(c, 'products', PRODUCTS_CSV);

    const customers = await importCsv(
      c,
      'customers',
      [
        'Account Code,Customer Name,Order Email,Email Domain,Price List,On Stop,Address 1,Town,Postcode',
        'BREW001,Brew Cafe,orders@brewcafe.example,brewcafe.example,A,N,1 High Street,Leeds,ls1 4ab',
        'BREW001,Brew Cafe,orders@brewcafe.example; Buyer@BrewCafe.example,,A,N,Unit 2 Mill Road,York,YO1 7HH',
        'OAK001,Oak Kitchen,not-an-email,,,Y,5 Park Avenue,Bath,BA1 1AA',
        'OAK002,Oak Deli,,,B,Y,,,',
      ].join('\n'),
    );
    expect(customers.totals).toMatchObject({ rows: 4, created: 2, skipped: 1 });
    expect(customers.errors[0]).toMatchObject({ row: 4, field: 'senderAddresses' });
    const brew = await Customer.findOne({ orgId: admin.orgId, accountKey: 'BREW001' });
    expect(brew!.senderAddresses.sort()).toEqual([
      'buyer@brewcafe.example',
      'orders@brewcafe.example',
    ]);
    expect(brew!.deliveryAddresses.map((a) => a.postcode)).toEqual(['LS1 4AB', 'YO1 7HH']);
    expect((await Customer.findOne({ orgId: admin.orgId, accountKey: 'OAK002' }))!.creditHold).toBe(
      true,
    );

    const prices = await importCsv(
      c,
      'prices',
      [
        'Account Code,Price List,Stock Code,Net Price,Min Qty',
        'BREW001,,GL1001,4.10,',
        'BREW001,,GL1001,3.90,10',
        ',A,GL1002,4.40,',
        'NOPE,,GL1001,1,',
        'BREW001,,ZZZ,1,',
        ',,GL1001,1,',
      ].join('\n'),
    );
    expect(prices.totals).toMatchObject({ rows: 6, created: 3, skipped: 3 });
    expect(prices.errors.map((e: { message: string }) => e.message)).toEqual([
      'Unknown customer account "NOPE" - import customers first',
      'Unknown SKU "ZZZ" - import products first',
      'Each row needs a customer account code or a price list code',
    ]);
    const custPrices = await c.get(`/api/customers/${brew!._id}/prices`);
    expect(custPrices.body.total).toBe(3); // 2 contract + 1 from price list A

    const xrefs = await importCsv(
      c,
      'cross_references',
      [
        'Account Code,Customer Part Code,Customer Description,Our SKU,Factor',
        'BREW001,bw-77,,GL1001,',
        'BREW001,,LARGE BLUE GLOVES,GL1002,1',
        'OAK001,X1,,GL1001,0',
      ].join('\n'),
    );
    expect(xrefs.totals).toMatchObject({ created: 2, skipped: 1 });

    const list = await c.get(`/api/cross-references?customerId=${brew!._id}`);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items.find((x: { sku: string }) => x.sku === 'GL1001')).toMatchObject({
      customerName: 'Brew Cafe',
      productDescription: 'Nitrile Gloves Blue Medium (Box 100)',
      customerPartCode: 'bw-77',
    });

    // Same code typed differently updates the same cross-reference.
    const again = await importCsv(
      c,
      'cross_references',
      'Account Code,Customer Part Code,Our SKU\nbrew001,BW 77,GL1002',
    );
    expect(again.totals).toMatchObject({ created: 0, updated: 1 });

    const exported = await c.get('/api/cross-references/export');
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.text).toContain('Customer account code');
    // Round trip: the export re-imports cleanly with the auto-mapping.
    const roundTrip = await importCsv(c, 'cross_references', exported.text.slice(1));
    expect(roundTrip.totals).toMatchObject({ errors: 0, created: 0, updated: 2 });
  });

  it('lets admins edit customer settings; search finds customers by name, code or sender', async () => {
    const { c, admin } = await adminClient();
    await importCsv(
      c,
      'customers',
      'Account Code,Customer Name,Order Email\nBREW001,Brew Cafe,orders@brewcafe.example\nOAK001,Oak Kitchen,',
    );
    const brew = await Customer.findOne({ orgId: admin.orgId, accountKey: 'BREW001' });

    expect((await c.get('/api/customers?q=brew')).body.total).toBe(1);
    expect((await c.get('/api/customers?q=oak001')).body.items[0].name).toBe('Oak Kitchen');
    expect(
      (await c.get('/api/customers?q=orders@brewcafe.example')).body.items[0].accountCode,
    ).toBe('BREW001');

    const res = await c.patch(`/api/customers/${brew!._id}`, {
      trustedForAutoApprove: true,
      emailDomains: ['BrewCafe.example'],
    });
    expect(res.status).toBe(200);
    expect(res.body.customer).toMatchObject({
      trustedForAutoApprove: true,
      emailDomains: ['brewcafe.example'],
    });
    expect(
      (await c.patch(`/api/customers/${brew!._id}`, { emailDomains: ['not a domain'] })).status,
    ).toBe(400);

    const viewer = await t.createUser({ role: 'viewer', orgId: admin.orgId });
    const vc = await t.loginAs(viewer.email);
    expect((await vc.patch(`/api/customers/${brew!._id}`, { creditHold: true })).status).toBe(403);
  });
});

describe('catalogue tenant isolation', () => {
  it('org B cannot see org A products, customers, imports or cross-references', async () => {
    const { c, admin } = await adminClient();
    const job = await importCsv(c, 'products', PRODUCTS_CSV);
    await importCsv(c, 'customers', 'Account Code,Customer Name\nBREW001,Brew Cafe');
    const product = await Product.findOne({ orgId: admin.orgId, skuKey: 'GL1001' });
    const customer = await Customer.findOne({ orgId: admin.orgId });

    const other = await t.createUser({ role: 'owner' });
    const b = await t.loginAs(other.email);
    expect((await b.get('/api/products')).body.total).toBe(0);
    expect((await b.get('/api/customers')).body.total).toBe(0);
    expect((await b.get(`/api/products/${product!._id}`)).status).toBe(404);
    expect((await b.get(`/api/customers/${customer!._id}`)).status).toBe(404);
    expect((await b.patch(`/api/customers/${customer!._id}`, { creditHold: true })).status).toBe(
      404,
    );
    expect((await b.get(`/api/imports/${job.id}`)).status).toBe(404);
    expect((await b.post(`/api/imports/${job.id}/commit`, {})).status).toBe(404);
    expect((await b.get('/api/imports')).body.items).toEqual([]);
  });
});
