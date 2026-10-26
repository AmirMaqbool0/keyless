/**
 * Builds the 20 synthetic, deliberately messy purchase-order fixtures with their ground truth:
 * fixtures/<nn-name>/email.eml + expected.json. Deterministic (seeded): re-running produces the
 * same orders. Usage: pnpm --filter @keyless/eval generate
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateDemoData,
  type DemoCustomer,
  type DemoProduct,
} from '@keyless/core/demo/generator';
import {
  STANDARD_LAYOUT,
  buildEmail,
  poCsv,
  poImage,
  poPdf,
  poXlsx,
  round2,
  scannedPdf,
  subtotalOf,
  type EmailSpec,
  type PdfLayout,
  type PoLine,
  type PoSpec,
} from './builders';
import type { ExpectedOrder, Fixture } from './types';

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');
const EMAIL_DATE = '2026-10-20T09:14:00Z';
const ORDER_DATE = '2026-10-20';

// --- deterministic picking --------------------------------------------------------------
let seed = 20261020;
const rand = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const data = generateDemoData();
const active = data.products.filter((p) => p.active);
const customersWithRefs = data.customers.filter((c) =>
  data.crossReferences.some((x) => x.accountCode === c.accountCode),
);
const pickProducts = (n: number): DemoProduct[] =>
  Array.from({ length: n }, () => active[int(0, active.length - 1)]!);
const shortDesc = (p: DemoProduct) => p.description.replace(/\s*\(.*\)$/, '');

type LineMode = 'sku' | 'customer-codes' | 'no-code';
type Built = { po: PoSpec; skus: (string | null)[] };

function buildPo(
  customer: DemoCustomer,
  n: number,
  opts: {
    prices?: boolean;
    mode?: LineMode;
    units?: boolean;
    delivery?: string;
    notes?: string;
    account?: boolean;
  } = {},
): Built {
  const mode = opts.mode ?? 'sku';
  const refs = data.crossReferences.filter(
    (x) => x.accountCode === customer.accountCode && x.customerPartCode,
  );
  const lines: PoLine[] = [];
  const skus: (string | null)[] = [];
  for (let i = 0; i < n; i++) {
    if (mode === 'customer-codes' && refs.length) {
      const ref = refs[i % refs.length]!;
      const product = data.products.find((p) => p.sku === ref.sku)!;
      lines.push({
        code: ref.customerPartCode!,
        description: ref.customerDescription ?? shortDesc(product),
        qty: int(1, 24),
        unit: opts.units ? 'Case' : undefined,
        price: opts.prices === false ? undefined : product.defaultPrice,
      });
      skus.push(product.sku);
    } else {
      const p = pickProducts(1)[0]!;
      lines.push({
        code: mode === 'no-code' ? null : p.sku,
        description: mode === 'no-code' ? shortDesc(p) : p.description,
        qty: int(1, 30),
        unit: opts.units
          ? p.uom === 'BOX'
            ? 'Box'
            : p.uom === 'CASE'
              ? 'Case'
              : 'Pack'
          : undefined,
        price: opts.prices === false ? undefined : p.defaultPrice,
      });
      skus.push(p.sku);
    }
  }
  const addr = customer.deliveryAddresses[0]!;
  return {
    po: {
      customerName: customer.name,
      accountNumber: opts.account ? customer.accountCode : undefined,
      poNumber: `PO-${int(100000, 999999)}`,
      orderDate: ORDER_DATE,
      deliveryDate: opts.delivery,
      address: [addr.line1, addr.city, addr.postcode],
      lines,
      notes: opts.notes,
    },
    skus,
  };
}

type Shown = {
  currency?: boolean;
  name?: boolean;
  account?: boolean;
  po?: boolean;
  orderDate?: boolean;
  deliveryDate?: boolean;
  address?: boolean;
  prices?: boolean;
  units?: boolean;
  totals?: 'subtotal' | 'vat' | 'none';
};

function expected(b: Built, shown: Shown): ExpectedOrder {
  const { po } = b;
  const sub = subtotalOf(po);
  return {
    customerName: shown.name === false ? null : po.customerName,
    accountNumber: shown.account ? (po.accountNumber ?? null) : null,
    poNumber: shown.po === false ? null : po.poNumber,
    orderDate: shown.orderDate === false ? null : po.orderDate,
    requestedDeliveryDate: shown.deliveryDate ? (po.deliveryDate ?? null) : null,
    deliveryAddress:
      shown.address === false
        ? { line1: null, postcode: null }
        : { line1: po.address[0] ?? null, postcode: po.address[po.address.length - 1] ?? null },
    // Only when a currency symbol is printed (spreadsheets carry bare numbers).
    currency: shown.prices === false || shown.currency === false ? null : 'GBP',
    totals: {
      subtotal: shown.totals === 'none' || shown.prices === false ? null : sub,
      tax: shown.totals === 'vat' ? round2(sub * 0.2) : null,
      total: shown.totals === 'vat' ? round2(sub * 1.2) : null,
    },
    lines: po.lines.map((l, i) => ({
      customerPartCode: l.code,
      description: l.description,
      quantity: l.qty,
      unit: shown.units ? (l.unit ?? null) : null,
      unitPrice: shown.prices === false ? null : (l.price ?? null),
      expectedSku: b.skus[i] ?? null,
    })),
  };
}

const sender = (c: DemoCustomer) => ({ name: 'Sam Buyer', address: c.senderAddresses[0]! });
const sign = (c: DemoCustomer) => `\n\nKind regards,\nSam Buyer\n${c.name}`;
const pickCustomer = (pool = data.customers) => pool[int(0, pool.length - 1)]!;

type FixtureDef = {
  name: string;
  description: string;
  tags: string[];
  build: () => Promise<{ email: EmailSpec; orders: ExpectedOrder[] }>;
};

const fixtures: FixtureDef[] = [];
const add = (f: FixtureDef) => fixtures.push(f);
// Called from build(), so count calls rather than registered fixtures (all are registered by then).
let seq = 0;
const id = () => `fx-${++seq}`;

add({
  name: 'pdf-standard',
  description: 'Clean ERP-style PDF: code, description, qty, price, total, subtotal.',
  tags: ['pdf'],
  build: async () => {
    const c = pickCustomer();
    const b = buildPo(c, 4);
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: `Purchase Order ${b.po.poNumber}`,
        text: `Hi,\n\nPlease find our order attached.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [{ filename: `${b.po.poNumber}.pdf`, content: await poPdf([b.po]) }],
      },
      orders: [expected(b, { totals: 'subtotal' })],
    };
  },
});

add({
  name: 'pdf-reordered-columns',
  description:
    'Quantity first, unusual headers ("Your Ref", "Price Each", "Value"), long dates, VAT totals.',
  tags: ['pdf'],
  build: async () => {
    const c = pickCustomer();
    const b = buildPo(c, 5);
    const layout: PdfLayout = {
      columns: ['qty', 'description', 'code', 'price', 'total'],
      labels: {
        qty: 'Quantity',
        description: 'Item Description',
        code: 'Your Ref',
        price: 'Price Each',
        total: 'Value',
      },
      poLabel: 'Order No.',
      dateFormat: 'long',
      deliveryLabel: 'Delivery address:',
      totals: 'vat',
    };
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: `New order ${b.po.poNumber}`,
        text: `Morning, order attached.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [{ filename: 'order.pdf', content: await poPdf([b.po], layout) }],
      },
      orders: [expected(b, { totals: 'vat' })],
    };
  },
});

add({
  name: 'pdf-no-prices',
  description: 'No prices on the PO, units column instead.',
  tags: ['pdf'],
  build: async () => {
    const c = pickCustomer();
    const b = buildPo(c, 6, { prices: false, units: true });
    const layout: PdfLayout = {
      ...STANDARD_LAYOUT,
      columns: ['code', 'description', 'qty', 'unit'],
      totals: 'none',
    };
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: `PO ${b.po.poNumber}`,
        text: `Please supply as attached.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [
          { filename: `PO_${b.po.poNumber}.pdf`, content: await poPdf([b.po], layout) },
        ],
      },
      orders: [expected(b, { prices: false, units: true, totals: 'none' })],
    };
  },
});

add({
  name: 'pdf-multipage',
  description: '38 lines over two pages with a repeated table header.',
  tags: ['pdf', 'long'],
  build: async () => {
    const c = pickCustomer();
    const b = buildPo(c, 38);
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: `Weekly order ${b.po.poNumber}`,
        text: `Weekly order attached.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [{ filename: `${b.po.poNumber}.pdf`, content: await poPdf([b.po]) }],
      },
      orders: [expected(b, { totals: 'subtotal' })],
    };
  },
});

add({
  name: 'pdf-two-orders',
  description: 'Two separate POs (two delivery sites) in one PDF.',
  tags: ['pdf', 'multi-order'],
  build: async () => {
    const c =
      pickCustomer(data.customers.filter((x) => x.deliveryAddresses.length > 1)) ?? pickCustomer();
    const a = buildPo(c, 3);
    const b = buildPo(c, 4);
    const second = c.deliveryAddresses[1] ?? c.deliveryAddresses[0]!;
    b.po.address = [second.line1, second.city, second.postcode];
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: `Orders ${a.po.poNumber} and ${b.po.poNumber}`,
        text: `Two orders attached, one per site.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [{ filename: 'orders.pdf', content: await poPdf([a.po, b.po]) }],
      },
      orders: [expected(a, { totals: 'subtotal' }), expected(b, { totals: 'subtotal' })],
    };
  },
});

add({
  name: 'two-pdf-attachments',
  description: 'Two POs as two separate PDF attachments.',
  tags: ['pdf', 'multi-order'],
  build: async () => {
    const c = pickCustomer();
    const a = buildPo(c, 2);
    const b = buildPo(c, 3);
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: 'Two orders',
        text: `Hi, two orders attached.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [
          { filename: `${a.po.poNumber}.pdf`, content: await poPdf([a.po]) },
          { filename: `${b.po.poNumber}.pdf`, content: await poPdf([b.po]) },
        ],
      },
      orders: [expected(a, { totals: 'subtotal' }), expected(b, { totals: 'subtotal' })],
    };
  },
});

add({
  name: 'pdf-customer-codes',
  description: "Customer's own part codes (cross-referenced), delivery date and delivery notes.",
  tags: ['pdf', 'customer-codes'],
  build: async () => {
    const c = pickCustomer(customersWithRefs);
    const b = buildPo(c, 5, {
      mode: 'customer-codes',
      delivery: '2026-10-27',
      notes: 'Rear entrance before 10am',
    });
    const layout: PdfLayout = {
      ...STANDARD_LAYOUT,
      labels: { ...STANDARD_LAYOUT.labels, code: 'Your code' },
      deliveryDateLabel: 'Required by:',
    };
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: `Order ${b.po.poNumber}`,
        text: `Order attached.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [{ filename: `${b.po.poNumber}.pdf`, content: await poPdf([b.po], layout) }],
      },
      orders: [expected(b, { totals: 'subtotal', deliveryDate: true })],
    };
  },
});

add({
  name: 'pdf-scanned',
  description: 'Scanned PO: image-only PDF, slightly rotated and blurred, no text layer.',
  tags: ['pdf', 'scanned', 'vision'],
  build: async () => {
    const c = pickCustomer();
    const b = buildPo(c, 4);
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: `Scanned order ${b.po.poNumber}`,
        text: `Scan attached.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [{ filename: 'scan0001.pdf', content: await scannedPdf(b.po) }],
      },
      orders: [expected(b, { totals: 'subtotal' })],
    };
  },
});

add({
  name: 'photo-jpg',
  description: 'Phone photo of a printed PO (JPEG, rotated, uneven background).',
  tags: ['image', 'vision'],
  build: async () => {
    const c = pickCustomer();
    const b = buildPo(c, 3);
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: 'Order photo',
        text: `Sent from my phone - order ${b.po.poNumber} photo attached.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [
          { filename: 'IMG_2041.jpg', content: await poImage(b.po, { rotate: 3, jpeg: true }) },
        ],
      },
      orders: [expected(b, { totals: 'subtotal' })],
    };
  },
});

add({
  name: 'xlsx-title-rows',
  description: 'Excel PO with title rows (PO, date, address) above the item table.',
  tags: ['spreadsheet'],
  build: async () => {
    const c = pickCustomer();
    const b = buildPo(c, 6);
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: `Order ${b.po.poNumber}`,
        text: `Spreadsheet attached.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [
          {
            filename: 'order.xlsx',
            content: await poXlsx([b.po], { titleRows: true, poColumn: false }),
          },
        ],
      },
      orders: [expected(b, { totals: 'none', currency: false })],
    };
  },
});

add({
  name: 'xlsx-plain',
  description: 'Bare Excel table; PO number only in the email subject; no date or address.',
  tags: ['spreadsheet'],
  build: async () => {
    const c = pickCustomer();
    const b = buildPo(c, 5);
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: `Order ${b.po.poNumber}`,
        text: `Please see attached.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [
          {
            filename: 'items.xlsx',
            content: await poXlsx([b.po], { titleRows: false, poColumn: false }),
          },
        ],
      },
      orders: [expected(b, { totals: 'none', orderDate: false, address: false, currency: false })],
    };
  },
});

add({
  name: 'csv-single',
  description: 'CSV export of one order; PO in the subject.',
  tags: ['csv'],
  build: async () => {
    const c = pickCustomer();
    const b = buildPo(c, 4);
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: `PO ${b.po.poNumber}`,
        text: `Order export attached.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [{ filename: 'export.csv', content: poCsv([b.po], { poColumn: false }) }],
      },
      orders: [expected(b, { totals: 'none', orderDate: false, address: false, currency: false })],
    };
  },
});

add({
  name: 'csv-two-orders',
  description: 'One CSV holding two POs, split by a PO Number column.',
  tags: ['csv', 'multi-order'],
  build: async () => {
    const c = pickCustomer();
    const a = buildPo(c, 2);
    const b = buildPo(c, 3);
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: 'Orders this week',
        text: `Two orders in the attached file.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [{ filename: 'orders.csv', content: poCsv([a.po, b.po], { poColumn: true }) }],
      },
      orders: [a, b].map((x) =>
        expected(x, { totals: 'none', orderDate: false, address: false, currency: false }),
      ),
    };
  },
});

function bodyFixture(
  name: string,
  description: string,
  render: (lines: PoLine[]) => string,
  mode: LineMode,
  n: number,
  extra: Partial<Shown> = {},
  unitWord?: (qty: number) => string,
) {
  add({
    name,
    description,
    tags: ['body'],
    build: async () => {
      const c = pickCustomer(mode === 'customer-codes' ? customersWithRefs : data.customers);
      const b = buildPo(c, n, { prices: false, mode });
      // When the email states a unit ("5 cases of"), it is part of the truth.
      if (unitWord) for (const l of b.po.lines) l.unit = unitWord(l.qty);
      return {
        email: {
          id: id(),
          from: sender(c),
          subject: `Order ${b.po.poNumber}`,
          text: `Hi team,\n\n${render(b.po.lines)}${sign(c)}`,
          date: EMAIL_DATE,
        },
        orders: [
          expected(b, {
            prices: false,
            totals: 'none',
            orderDate: false,
            address: false,
            units: Boolean(unitWord),
            ...extra,
          }),
        ],
      };
    },
  });
}

bodyFixture(
  'body-qty-x-code',
  'Order typed in the email: "10 x CODE description".',
  (ls) =>
    `Could you please send the following:\n\n${ls.map((l) => `${l.qty} x ${l.code} ${l.description}`).join('\n')}\n\nDeliver to our usual address.`,
  'sku',
  4,
);
bodyFixture(
  'body-code-dash-qty',
  'Order typed as "CODE - description - qty".',
  (ls) =>
    `Order below please:\n\n${ls.map((l) => `${l.code} - ${l.description} - ${l.qty}`).join('\n')}`,
  'customer-codes',
  4,
);
bodyFixture(
  'body-free-text',
  'Free text, no codes: "Can we get 5 cases of ... and 2 boxes of ...".',
  (ls) =>
    `Can we get ${ls.map((l) => `${l.qty} ${l.qty === 1 ? 'case' : 'cases'} of ${l.description.toLowerCase()}`).join(' and ')} please?`,
  'no-code',
  2,
  {},
  (qty) => (qty === 1 ? 'case' : 'cases'),
);
bodyFixture(
  'body-tab-table',
  'A table pasted from Excel into the email (tab-separated).',
  (ls) =>
    `Order:\n\nCode\tDescription\tQty\n${ls.map((l) => `${l.code}\t${l.description}\t${l.qty}`).join('\n')}`,
  'sku',
  5,
);

add({
  name: 'forwarded-body-order',
  description: 'A colleague forwards a customer order written in the email body.',
  tags: ['body', 'forwarded'],
  build: async () => {
    const c = pickCustomer();
    const b = buildPo(c, 3, { prices: false });
    const order = b.po.lines.map((l) => `${l.qty} x ${l.code} ${l.description}`).join('\n');
    return {
      email: {
        id: id(),
        from: { name: 'Pat (Sales)', address: 'pat@distributor.example' },
        subject: `Fwd: Order ${b.po.poNumber}`,
        text: `Can you process this one?\n\n---------- Forwarded message ---------\nFrom: Sam Buyer <${c.senderAddresses[0]}>\nSubject: Order ${b.po.poNumber}\n\nHi,\n\nPlease send:\n${order}${sign(c)}`,
        date: EMAIL_DATE,
      },
      orders: [expected(b, { prices: false, totals: 'none', orderDate: false, address: false })],
    };
  },
});

add({
  name: 'pdf-vat-account-dates',
  description: 'Account number, "required by" long-form delivery date, subtotal/VAT/total.',
  tags: ['pdf'],
  build: async () => {
    const c = pickCustomer();
    const b = buildPo(c, 4, { account: true, delivery: '2026-11-30' });
    const layout: PdfLayout = {
      ...STANDARD_LAYOUT,
      dateFormat: 'long',
      deliveryDateLabel: 'Required by',
      totals: 'vat',
    };
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: `Purchase order ${b.po.poNumber}`,
        text: `Attached.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [{ filename: `${b.po.poNumber}.pdf`, content: await poPdf([b.po], layout) }],
      },
      orders: [expected(b, { totals: 'vat', account: true, deliveryDate: true })],
    };
  },
});

add({
  name: 'pdf-wrapped-units',
  description: 'Long descriptions that wrap onto two lines, plus a unit column.',
  tags: ['pdf'],
  build: async () => {
    const c = pickCustomer();
    const b = buildPo(c, 5, { units: true });
    for (const l of b.po.lines)
      l.description = `${l.description} - food safe, recyclable, supplied in outer cartons`;
    const layout: PdfLayout = {
      ...STANDARD_LAYOUT,
      columns: ['code', 'description', 'qty', 'unit', 'price', 'total'],
    };
    return {
      email: {
        id: id(),
        from: sender(c),
        subject: `PO ${b.po.poNumber}`,
        text: `Order attached.${sign(c)}`,
        date: EMAIL_DATE,
        attachments: [{ filename: `${b.po.poNumber}.pdf`, content: await poPdf([b.po], layout) }],
      },
      orders: [expected(b, { totals: 'subtotal', units: true })],
    };
  },
});

async function main(): Promise<void> {
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const [i, def] of fixtures.entries()) {
    const dir = path.join(FIXTURES_DIR, `${String(i + 1).padStart(2, '0')}-${def.name}`);
    fs.mkdirSync(dir);
    const { email, orders } = await def.build();
    fs.writeFileSync(path.join(dir, 'email.eml'), await buildEmail(email));
    const fixture: Fixture = {
      name: def.name,
      description: def.description,
      tags: def.tags,
      orders,
    };
    fs.writeFileSync(path.join(dir, 'expected.json'), `${JSON.stringify(fixture, null, 2)}\n`);
  }
  console.log(`Wrote ${fixtures.length} fixtures to ${FIXTURES_DIR}`);
}

await main();
