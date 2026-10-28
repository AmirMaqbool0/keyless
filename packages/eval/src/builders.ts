import ExcelJS from 'exceljs';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';

/** Document builders for synthetic purchase orders in the shapes customers really send. */

export type PoLine = {
  code: string | null;
  description: string;
  qty: number;
  unit?: string;
  price?: number;
};
export type PoSpec = {
  customerName: string;
  accountNumber?: string;
  poNumber: string;
  orderDate: string; // ISO
  deliveryDate?: string; // ISO
  address: string[]; // line1, [line2], city, postcode
  lines: PoLine[];
  notes?: string;
};

export type Column = 'code' | 'description' | 'qty' | 'unit' | 'price' | 'total';
export type PdfLayout = {
  columns: Column[];
  labels: Partial<Record<Column, string>>;
  poLabel: string;
  dateFormat: 'uk' | 'iso' | 'long';
  deliveryLabel: string;
  deliveryDateLabel?: string;
  totals: 'subtotal' | 'vat' | 'none';
};

export const STANDARD_LAYOUT: PdfLayout = {
  columns: ['code', 'description', 'qty', 'price', 'total'],
  labels: {
    code: 'Item code',
    description: 'Description',
    qty: 'Qty',
    unit: 'Unit',
    price: 'Unit price',
    total: 'Total',
  },
  poLabel: 'PO Number:',
  dateFormat: 'uk',
  deliveryLabel: 'Deliver to:',
  totals: 'subtotal',
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const ordinal = (d: number) =>
  d % 10 === 1 && d !== 11
    ? 'st'
    : d % 10 === 2 && d !== 12
      ? 'nd'
      : d % 10 === 3 && d !== 13
        ? 'rd'
        : 'th';

export function formatDate(iso: string, style: PdfLayout['dateFormat']): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  if (style === 'iso') return iso;
  if (style === 'long') return `${d}${ordinal(d)} ${MONTHS[m - 1]} ${y}`;
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

const money = (n: number) => `£${n.toFixed(2)}`;
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const subtotalOf = (po: PoSpec) =>
  round2(po.lines.reduce((s, l) => s + (l.price ?? 0) * l.qty, 0));

const COL_WIDTH: Record<Column, number> = {
  code: 80,
  description: 210,
  qty: 40,
  unit: 55,
  price: 65,
  total: 65,
};

function cellText(line: PoLine, col: Column): string {
  switch (col) {
    case 'code':
      return line.code ?? '';
    case 'description':
      return line.description;
    case 'qty':
      return String(line.qty);
    case 'unit':
      return line.unit ?? '';
    case 'price':
      return line.price === undefined ? '' : money(line.price);
    case 'total':
      return line.price === undefined ? '' : money(line.price * line.qty);
  }
}

/** One or more POs in one PDF; each PO starts a new page; long POs paginate with repeated headers. */
export function poPdf(orders: PoSpec[], layout: PdfLayout = STANDARD_LAYOUT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const widths = layout.columns.map((c) => COL_WIDTH[c]);
    const tableHeader = (y: number) => {
      doc.font('Helvetica-Bold').fontSize(9);
      let x = 50;
      layout.columns.forEach((c, i) => {
        doc.text(layout.labels[c] ?? c, x, y, { width: widths[i]! - 6 });
        x += widths[i]!;
      });
      doc.font('Helvetica');
      return y + 16;
    };

    for (const po of orders) {
      doc.addPage();
      doc.fontSize(16).font('Helvetica-Bold').text(po.customerName, 50, 50);
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#555')
        .text('Purchasing Department')
        .fillColor('#000');
      if (po.accountNumber) doc.text(`Account No: ${po.accountNumber}`);
      doc
        .fontSize(15)
        .font('Helvetica-Bold')
        .text('PURCHASE ORDER', 330, 50, { width: 215, align: 'right' });
      doc.font('Helvetica').fontSize(10);
      doc.text(`${layout.poLabel} ${po.poNumber}`, 330, 72, { width: 215, align: 'right' });
      doc.text(`Date: ${formatDate(po.orderDate, layout.dateFormat)}`, 330, 86, {
        width: 215,
        align: 'right',
      });
      if (po.deliveryDate) {
        doc.text(
          `${layout.deliveryDateLabel ?? 'Delivery date:'} ${formatDate(po.deliveryDate, layout.dateFormat)}`,
          330,
          100,
          { width: 215, align: 'right' },
        );
      }
      doc.fontSize(10).text(layout.deliveryLabel, 50, 130, { underline: true });
      po.address.forEach((l) => doc.text(l, 50));
      let y = tableHeader(doc.y + 18);

      doc.fontSize(9);
      for (const line of po.lines) {
        const h = Math.max(
          14,
          doc.heightOfString(line.description, { width: COL_WIDTH.description - 6 }) + 4,
        );
        if (y + h > 760) {
          doc.addPage();
          doc.fontSize(9).text(`${po.customerName} - PO ${po.poNumber} (continued)`, 50, 50);
          y = tableHeader(72);
          doc.fontSize(9);
        }
        let x = 50;
        layout.columns.forEach((c, i) => {
          doc.text(cellText(line, c), x, y, { width: widths[i]! - 6 });
          x += widths[i]!;
        });
        y += h;
      }
      const sub = subtotalOf(po);
      doc.fontSize(10);
      if (layout.totals !== 'none') {
        doc.font('Helvetica-Bold').text(`Subtotal: ${money(sub)}`, 360, y + 12);
        if (layout.totals === 'vat') {
          doc.text(`VAT (20%): ${money(round2(sub * 0.2))}`, 360);
          doc.text(`Total: ${money(round2(sub * 1.2))}`, 360);
        }
        doc.font('Helvetica');
      }
      if (po.notes) doc.text(`Delivery notes: ${po.notes}`, 50, doc.y + 18);
      doc.fontSize(8).text('Please confirm receipt of this order.', 50, doc.y + 14);
    }
    doc.end();
  });
}

const escapeXml = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!,
  );

/** A PO page as an image (no text layer): for scanned PDFs and phone photos. */
export async function poImage(
  po: PoSpec,
  opts: { rotate: number; jpeg: boolean; blur?: number },
): Promise<Buffer> {
  const rows: string[] = [];
  let y = 90;
  const t = (x: number, text: string, size = 22, weight = 'normal') => {
    rows.push(
      `<text x="${x}" y="${y}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" fill="#1a1a1a">${escapeXml(text)}</text>`,
    );
  };
  t(70, po.customerName, 36, 'bold');
  t(900, 'PURCHASE ORDER', 34, 'bold');
  y += 50;
  t(900, `PO Number: ${po.poNumber}`);
  y += 34;
  t(900, `Date: ${formatDate(po.orderDate, 'uk')}`);
  y += 70;
  t(70, 'Deliver to:', 22, 'bold');
  for (const l of po.address) {
    y += 32;
    t(70, l);
  }
  y += 70;
  const cols = [70, 260, 900, 1010, 1180];
  ['Item code', 'Description', 'Qty', 'Unit price', 'Total'].forEach((h, i) =>
    t(cols[i]!, h, 22, 'bold'),
  );
  for (const line of po.lines) {
    y += 40;
    const cells = [
      line.code ?? '',
      line.description.length > 48 ? `${line.description.slice(0, 46)}…` : line.description,
      String(line.qty),
      line.price === undefined ? '' : money(line.price),
      line.price === undefined ? '' : money(line.price * line.qty),
    ];
    cells.forEach((c, i) => t(cols[i]!, c));
  }
  y += 70;
  t(1010, `Subtotal: ${money(subtotalOf(po))}`, 22, 'bold');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1360" height="${y + 120}"><rect width="100%" height="100%" fill="#fbfaf6"/>${rows.join('')}</svg>`;
  let img = sharp(Buffer.from(svg)).rotate(opts.rotate, {
    background: opts.jpeg ? '#d8d4cc' : '#ffffff',
  });
  if (opts.blur) img = img.blur(opts.blur);
  return opts.jpeg ? img.jpeg({ quality: 70 }).toBuffer() : img.png().toBuffer();
}

/** A "scanned" PDF: image-only pages, no text layer. */
export async function scannedPdf(po: PoSpec): Promise<Buffer> {
  const png = await poImage(po, { rotate: 0.8, jpeg: false, blur: 0.5 });
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.image(png, 20, 30, { width: 555 });
    doc.end();
  });
}

/** An Excel PO, optionally with title rows above the table, and optionally several POs. */
export async function poXlsx(
  orders: PoSpec[],
  opts: { titleRows: boolean; poColumn: boolean },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Order');
  const first = orders[0]!;
  if (opts.titleRows) {
    ws.addRow([`${first.customerName} - Purchase Order`]);
    ws.addRow([`PO Number: ${first.poNumber}`]);
    ws.addRow([`Order date: ${formatDate(first.orderDate, 'uk')}`]);
    ws.addRow([`Deliver to: ${first.address.join(', ')}`]);
    ws.addRow([]);
  }
  ws.addRow([
    ...(opts.poColumn ? ['PO Number'] : []),
    'Product Code',
    'Description',
    'Quantity',
    'Unit Price',
  ]);
  for (const po of orders) {
    for (const l of po.lines)
      ws.addRow([
        ...(opts.poColumn ? [po.poNumber] : []),
        l.code ?? '',
        l.description,
        l.qty,
        l.price ?? null,
      ]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function poCsv(orders: PoSpec[], opts: { poColumn: boolean }): Buffer {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = [
    [...(opts.poColumn ? ['PO Number'] : []), 'Item Code', 'Description', 'Qty', 'Unit Price']
      .map(q)
      .join(','),
  ];
  for (const po of orders) {
    for (const l of po.lines)
      rows.push(
        [
          ...(opts.poColumn ? [q(po.poNumber)] : []),
          q(l.code ?? ''),
          q(l.description),
          String(l.qty),
          l.price?.toFixed(2) ?? '',
        ].join(','),
      );
  }
  return Buffer.from(rows.join('\r\n'));
}

export type EmailSpec = {
  id: string;
  from: { name: string; address: string };
  subject: string;
  text: string;
  date: string; // ISO datetime
  attachments?: Mail.Attachment[];
};

/** Deterministic raw email (fixed Message-ID and Date). */
export function buildEmail(e: EmailSpec): Promise<Buffer> {
  return new MailComposer({
    from: e.from,
    to: 'orders@distributor.example',
    subject: e.subject,
    text: e.text,
    date: new Date(e.date),
    messageId: `<${e.id}@fixtures.keyless.local>`,
    attachments: e.attachments,
  })
    .compile()
    .build();
}
