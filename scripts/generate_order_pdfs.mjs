import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'packages', 'core', 'package.json'));
const PDFDocument = require('pdfkit');

const rootDir = process.cwd();
const outDirs = [
  path.join(rootDir, 'sample_files'),
  path.join(rootDir, 'apps', 'web', 'public', 'samples'),
];

for (const dir of outDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const money = (n) => `£${n.toFixed(2)}`;

// Order 1: Example Cafe Ltd (amirmaqbool055@gmail.com)
function createOrder1(filePath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Header
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#0f172a').text('Example Cafe Ltd', 50, 50);
    doc.fontSize(10).font('Helvetica').fillColor('#475569');
    doc.text('Purchasing Department');
    doc.text('Email: amirmaqbool055@gmail.com');
    doc.text('1 High Street, Leeds, LS1 4AB');

    doc.fillColor('#0f172a').fontSize(18).font('Helvetica-Bold').text('PURCHASE ORDER', 350, 50, { align: 'right' });
    doc.fontSize(10).font('Helvetica').fillColor('#475569');
    doc.text('PO Number: PO-EX-40192', 350, 78, { align: 'right' });
    doc.text('Date: 29/10/2026', 350, 93, { align: 'right' });
    doc.text('Account Code: CUST-001', 350, 108, { align: 'right' });

    // Addresses
    const y0 = 150;
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text('Deliver To:', 50, y0);
    doc.font('Helvetica').fontSize(10).fillColor('#334155');
    doc.text('Example Cafe Ltd\n1 High Street\nLeeds\nLS1 4AB\nUnited Kingdom', 50, y0 + 16);

    // Table Header
    const tableTop = 240;
    doc.rect(50, tableTop - 5, 495, 22).fill('#1e293b');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10);
    doc.text('SKU / Code', 60, tableTop);
    doc.text('Description', 140, tableTop);
    doc.text('Qty', 350, tableTop);
    doc.text('Unit Price', 410, tableTop);
    doc.text('Total', 485, tableTop);

    // Items
    const items = [
      { code: 'GL1001', desc: 'Nitrile Gloves Blue Medium (Box 100)', qty: 5, price: 4.50 },
      { code: 'COF-88', desc: 'Arabica Espresso Coffee Beans 1kg Bag', qty: 8, price: 14.50 },
      { code: 'CLEAN-10', desc: 'Multi-Surface Food Grade Sanitizer 5L', qty: 2, price: 16.20 },
    ];

    let y = tableTop + 27;
    let subtotal = 0;
    doc.font('Helvetica').fillColor('#0f172a');

    for (const it of items) {
      const lineTotal = it.qty * it.price;
      subtotal += lineTotal;
      doc.text(it.code, 60, y);
      doc.text(it.desc, 140, y, { width: 200 });
      doc.text(String(it.qty), 350, y);
      doc.text(money(it.price), 410, y);
      doc.text(money(lineTotal), 485, y);
      y += 24;
      doc.strokeColor('#e2e8f0').moveTo(50, y - 4).lineTo(545, y - 4).stroke();
    }

    const vat = subtotal * 0.20;
    const total = subtotal + vat;

    doc.font('Helvetica').fillColor('#334155');
    doc.text('Subtotal:', 380, y + 10);
    doc.text(money(subtotal), 485, y + 10);
    doc.text('VAT (20%):', 380, y + 26);
    doc.text(money(vat), 485, y + 26);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text('Total (GBP):', 380, y + 44);
    doc.text(money(total), 485, y + 44);

    doc.fontSize(9).font('Helvetica').fillColor('#64748b').text('Special Instructions: Regular weekly delivery. Please leave at rear kitchen loading bay before 11:00 AM.', 50, y + 80);

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// Order 2: Apex Fine Dining Group (amirmaqbortol055@gmail.com)
function createOrder2(filePath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // Header
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#0f172a').text('Apex Fine Dining Group', 50, 50);
    doc.fontSize(10).font('Helvetica').fillColor('#475569');
    doc.text('Procurement Operations');
    doc.text('Email: amirmaqbortol055@gmail.com');
    doc.text('12 Commercial Way, Manchester, M1 4ET');

    doc.fillColor('#0f172a').fontSize(18).font('Helvetica-Bold').text('PURCHASE ORDER', 350, 50, { align: 'right' });
    doc.fontSize(10).font('Helvetica').fillColor('#475569');
    doc.text('PO Number: PO-APEX-77821', 350, 78, { align: 'right' });
    doc.text('Date: 29/10/2026', 350, 93, { align: 'right' });
    doc.text('Account Code: CUST-002', 350, 108, { align: 'right' });

    // Addresses
    const y0 = 150;
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11).text('Deliver To:', 50, y0);
    doc.font('Helvetica').fontSize(10).fillColor('#334155');
    doc.text('Apex Fine Dining - Main Branch\n12 Commercial Way\nManchester\nM1 4ET\nUnited Kingdom', 50, y0 + 16);

    // Table Header
    const tableTop = 240;
    doc.rect(50, tableTop - 5, 495, 22).fill('#1e293b');
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10);
    doc.text('SKU / Code', 60, tableTop);
    doc.text('Description', 140, tableTop);
    doc.text('Qty', 350, tableTop);
    doc.text('Unit Price', 410, tableTop);
    doc.text('Total', 485, tableTop);

    // Items
    const items = [
      { code: 'NAP-33', desc: 'Luxury Linen Feel White Napkins (Box 1000)', qty: 4, price: 34.00 },
      { code: 'GL1002', desc: 'Nitrile Gloves Black Large (Box 100)', qty: 10, price: 5.20 },
      { code: 'DEG-05', desc: 'Heavy Duty Kitchen Degreaser 5L', qty: 3, price: 19.80 },
    ];

    let y = tableTop + 27;
    let subtotal = 0;
    doc.font('Helvetica').fillColor('#0f172a');

    for (const it of items) {
      const lineTotal = it.qty * it.price;
      subtotal += lineTotal;
      doc.text(it.code, 60, y);
      doc.text(it.desc, 140, y, { width: 200 });
      doc.text(String(it.qty), 350, y);
      doc.text(money(it.price), 410, y);
      doc.text(money(lineTotal), 485, y);
      y += 24;
      doc.strokeColor('#e2e8f0').moveTo(50, y - 4).lineTo(545, y - 4).stroke();
    }

    const vat = subtotal * 0.20;
    const total = subtotal + vat;

    doc.font('Helvetica').fillColor('#334155');
    doc.text('Subtotal:', 380, y + 10);
    doc.text(money(subtotal), 485, y + 10);
    doc.text('VAT (20%):', 380, y + 26);
    doc.text(money(vat), 485, y + 26);
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text('Total (GBP):', 380, y + 44);
    doc.text(money(total), 485, y + 44);

    doc.fontSize(9).font('Helvetica').fillColor('#64748b').text('Notes: Pallet delivery acceptable. Reference account CUST-002 on invoice.', 50, y + 80);

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

async function main() {
  for (const dir of outDirs) {
    await createOrder1(path.join(dir, 'Order1_Example_Cafe.pdf'));
    await createOrder2(path.join(dir, 'Order2_Apex_Dining.pdf'));
  }
  console.log('Successfully generated 2 custom test order PDFs in:');
  console.log(outDirs.join('\n'));
}

main().catch(console.error);
