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
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const money = (n) => `£${n.toFixed(2)}`;

// 1. Purchase Order PDF for Customer: Example Cafe Ltd
function generateCustomerPo1(filePath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(20).font('Helvetica-Bold').text('Example Cafe Ltd', 50, 50);
    doc.fontSize(10).font('Helvetica').fillColor('#555').text('Purchasing Department | orders@example-cafe.example');
    doc.text('1 High Street, Leeds, LS1 4AB');

    doc.fillColor('#000').fontSize(16).font('Helvetica-Bold').text('PURCHASE ORDER', 350, 50, { align: 'right' });
    doc.fontSize(10).font('Helvetica').text('PO Number: PO-982144', 350, 75, { align: 'right' });
    doc.text('Date: 29/10/2026', 350, 90, { align: 'right' });
    doc.text('Account: CUST-001', 350, 105, { align: 'right' });

    doc.moveDown(3);
    const y0 = 150;
    doc.fontSize(10).font('Helvetica-Bold').text('Deliver To:', 50, y0);
    doc.font('Helvetica').text('Example Cafe Ltd\n1 High Street\nLeeds\nLS1 4AB\nUnited Kingdom', 50, y0 + 15);

    const tableTop = 240;
    doc.rect(50, tableTop - 5, 495, 20).fill('#f1f5f9');
    doc.fillColor('#1e293b').font('Helvetica-Bold');
    doc.text('Item Code', 60, tableTop);
    doc.text('Description', 150, tableTop);
    doc.text('Qty', 350, tableTop);
    doc.text('Unit Price', 410, tableTop);
    doc.text('Total', 480, tableTop);

    const items = [
      { code: 'GL1001', desc: 'Nitrile Gloves Blue Medium (Box 100)', qty: 10, price: 4.50 },
      { code: 'PAP-02', desc: 'Paper Cups 12oz Eco Kraft (Pack 500)', qty: 4, price: 28.00 },
      { code: 'COF-88', desc: 'Arabica Espresso Beans 1kg Bag', qty: 6, price: 14.50 },
      { code: 'CLEAN-10', desc: 'Multi-Surface Food Grade Sanitizer 5L', qty: 2, price: 16.20 },
    ];

    let y = tableTop + 25;
    let subtotal = 0;
    doc.font('Helvetica').fillColor('#000');

    for (const it of items) {
      const lineTotal = it.qty * it.price;
      subtotal += lineTotal;
      doc.text(it.code, 60, y);
      doc.text(it.desc, 150, y, { width: 190 });
      doc.text(String(it.qty), 350, y);
      doc.text(money(it.price), 410, y);
      doc.text(money(lineTotal), 480, y);
      y += 24;
      doc.strokeColor('#e2e8f0').moveTo(50, y - 4).lineTo(545, y - 4).stroke();
    }

    const vat = subtotal * 0.20;
    const total = subtotal + vat;

    doc.font('Helvetica').text('Subtotal:', 380, y + 10);
    doc.text(money(subtotal), 480, y + 10);
    doc.text('VAT (20%):', 380, y + 26);
    doc.text(money(vat), 480, y + 26);
    doc.font('Helvetica-Bold').fontSize(12).text('Total:', 380, y + 44);
    doc.text(money(total), 480, y + 44);

    doc.fontSize(9).font('Helvetica').fillColor('#64748b').text('Special Instructions: Please deliver to the kitchen entrance at the rear before 11:00 AM.', 50, y + 80);

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// 2. Purchase Order PDF for Customer: Apex Fine Dining
function generateCustomerPo2(filePath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(20).font('Helvetica-Bold').text('Apex Fine Dining Group', 50, 50);
    doc.fontSize(10).font('Helvetica').fillColor('#555').text('Central Supply Chain | procurement@apexdining.co.uk');
    doc.text('12 Commercial Way, Manchester, M1 4ET');

    doc.fillColor('#000').fontSize(16).font('Helvetica-Bold').text('PURCHASE ORDER', 350, 50, { align: 'right' });
    doc.fontSize(10).font('Helvetica').text('PO Number: APEX-2026-891', 350, 75, { align: 'right' });
    doc.text('Date: 29/10/2026', 350, 90, { align: 'right' });
    doc.text('Account: CUST-002', 350, 105, { align: 'right' });

    doc.moveDown(3);
    const y0 = 150;
    doc.fontSize(10).font('Helvetica-Bold').text('Deliver To:', 50, y0);
    doc.font('Helvetica').text('Apex Dining - City Centre Branch\n12 Commercial Way\nManchester\nM1 4ET\nUnited Kingdom', 50, y0 + 15);

    const tableTop = 240;
    doc.rect(50, tableTop - 5, 495, 20).fill('#f1f5f9');
    doc.fillColor('#1e293b').font('Helvetica-Bold');
    doc.text('Item Code', 60, tableTop);
    doc.text('Description', 150, tableTop);
    doc.text('Qty', 350, tableTop);
    doc.text('Unit Price', 410, tableTop);
    doc.text('Total', 480, tableTop);

    const items = [
      { code: 'NAP-33', desc: 'Luxury Linen Feel White Napkins (Box 1000)', qty: 8, price: 34.00 },
      { code: 'GL1002', desc: 'Nitrile Gloves Black Large (Box 100)', qty: 15, price: 5.20 },
      { code: 'ROLL-01', desc: 'Catering Foil 450mm x 75m Dispenser Box', qty: 5, price: 11.50 },
      { code: 'DEG-05', desc: 'Heavy Duty Kitchen Degreaser Concentrate 5L', qty: 3, price: 19.80 },
    ];

    let y = tableTop + 25;
    let subtotal = 0;
    doc.font('Helvetica').fillColor('#000');

    for (const it of items) {
      const lineTotal = it.qty * it.price;
      subtotal += lineTotal;
      doc.text(it.code, 60, y);
      doc.text(it.desc, 150, y, { width: 190 });
      doc.text(String(it.qty), 350, y);
      doc.text(money(it.price), 410, y);
      doc.text(money(lineTotal), 480, y);
      y += 24;
      doc.strokeColor('#e2e8f0').moveTo(50, y - 4).lineTo(545, y - 4).stroke();
    }

    const vat = subtotal * 0.20;
    const total = subtotal + vat;

    doc.font('Helvetica').text('Subtotal:', 380, y + 10);
    doc.text(money(subtotal), 480, y + 10);
    doc.text('VAT (20%):', 380, y + 26);
    doc.text(money(vat), 480, y + 26);
    doc.font('Helvetica-Bold').fontSize(12).text('Total:', 380, y + 44);
    doc.text(money(total), 480, y + 44);

    doc.fontSize(9).font('Helvetica').fillColor('#64748b').text('Notes: Pallet delivery acceptable. Loading dock available at rear.', 50, y + 80);

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// 3. Product Catalogue PDF
function generateProductCataloguePdf(filePath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(22).font('Helvetica-Bold').text('Wholesale Product Catalogue', 50, 50);
    doc.fontSize(10).font('Helvetica').fillColor('#64748b').text('Complete inventory with SKUs, units, pack sizes and standard trade prices');

    doc.moveDown(2);
    const tableTop = 110;
    doc.rect(50, tableTop - 5, 495, 20).fill('#0f172a');
    doc.fillColor('#ffffff').font('Helvetica-Bold');
    doc.text('SKU', 60, tableTop);
    doc.text('Description', 130, tableTop);
    doc.text('Unit', 320, tableTop);
    doc.text('Pack Size', 380, tableTop);
    doc.text('Trade Price', 460, tableTop);

    const products = [
      { sku: 'GL1001', desc: 'Nitrile Gloves Blue Medium', unit: 'box', pack: '100', price: 4.50 },
      { sku: 'GL1002', desc: 'Nitrile Gloves Black Large', unit: 'box', pack: '100', price: 5.20 },
      { sku: 'GL1003', desc: 'Vinyl Gloves Clear Small', unit: 'box', pack: '100', price: 3.80 },
      { sku: 'PAP-01', desc: 'Paper Cups 8oz Single Wall', unit: 'case', pack: '1000', price: 32.00 },
      { sku: 'PAP-02', desc: 'Paper Cups 12oz Eco Kraft', unit: 'pack', pack: '500', price: 28.00 },
      { sku: 'COF-88', desc: 'Arabica Espresso Coffee Beans 1kg', unit: 'bag', pack: '1', price: 14.50 },
      { sku: 'COF-90', desc: 'Fairtrade Filter Coffee Grounds 1kg', unit: 'bag', pack: '1', price: 12.00 },
      { sku: 'NAP-33', desc: 'Luxury Linen Feel White Napkins', unit: 'box', pack: '1000', price: 34.00 },
      { sku: 'NAP-10', desc: 'Standard 2-Ply Lunch Napkins', unit: 'case', pack: '2000', price: 22.50 },
      { sku: 'ROLL-01', desc: 'Catering Foil 450mm x 75m', unit: 'roll', pack: '1', price: 11.50 },
      { sku: 'ROLL-02', desc: 'Cling Film 450mm x 300m', unit: 'roll', pack: '1', price: 13.20 },
      { sku: 'CLEAN-10', desc: 'Multi-Surface Sanitizer 5L', unit: 'can', pack: '1', price: 16.20 },
      { sku: 'DEG-05', desc: 'Heavy Duty Kitchen Degreaser 5L', unit: 'can', pack: '1', price: 19.80 },
    ];

    let y = tableTop + 25;
    doc.font('Helvetica').fillColor('#000');

    for (const p of products) {
      doc.text(p.sku, 60, y);
      doc.text(p.desc, 130, y, { width: 180 });
      doc.text(p.unit, 320, y);
      doc.text(p.pack, 380, y);
      doc.text(money(p.price), 460, y);
      y += 24;
      doc.strokeColor('#f1f5f9').moveTo(50, y - 4).lineTo(545, y - 4).stroke();
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// 4. Customer Directory PDF
function generateCustomerListPdf(filePath) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.fontSize(22).font('Helvetica-Bold').text('Customer Directory & Accounts', 50, 50);
    doc.fontSize(10).font('Helvetica').fillColor('#64748b').text('Customer accounts, authorized ordering emails and delivery destinations');

    doc.moveDown(2);
    const tableTop = 110;
    doc.rect(50, tableTop - 5, 495, 20).fill('#0f172a');
    doc.fillColor('#ffffff').font('Helvetica-Bold');
    doc.text('Code', 60, tableTop);
    doc.text('Customer Name', 120, tableTop);
    doc.text('Order Email', 260, tableTop);
    doc.text('Delivery City & Postcode', 400, tableTop);

    const customers = [
      { code: 'CUST-001', name: 'Example Cafe Ltd', email: 'orders@example-cafe.example', addr: 'Leeds, LS1 4AB' },
      { code: 'CUST-002', name: 'Apex Fine Dining Group', email: 'procurement@apexdining.co.uk', addr: 'Manchester, M1 4ET' },
      { code: 'CUST-003', name: 'The Highland Bistro', email: 'orders@highlandbistro.co.uk', addr: 'Edinburgh, EH1 2NG' },
      { code: 'CUST-004', name: 'Bayside Fish & Grill', email: 'supplies@baysidegrill.com', addr: 'Brighton, BN1 1AE' },
      { code: 'CUST-005', name: 'Riverside Artisan Bakery', email: 'bake@riversidebakery.co.uk', addr: 'Bristol, BS1 6XN' },
      { code: 'CUST-006', name: 'Metropolitan Hotel Supplies', email: 'purchasing@metrohotel.com', addr: 'London, W1A 1AA' },
    ];

    let y = tableTop + 25;
    doc.font('Helvetica').fillColor('#000');

    for (const c of customers) {
      doc.text(c.code, 60, y);
      doc.text(c.name, 120, y, { width: 130 });
      doc.text(c.email, 260, y, { width: 130 });
      doc.text(c.addr, 400, y);
      y += 28;
      doc.strokeColor('#f1f5f9').moveTo(50, y - 4).lineTo(545, y - 4).stroke();
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// 5. CSV Files for direct Catalogue Import (/imports)
function generateCsvFiles() {
  const customerCsv = `account_code,name,email,delivery_address_line1,delivery_city,delivery_postcode
CUST-001,Example Cafe Ltd,orders@example-cafe.example,1 High Street,Leeds,LS1 4AB
CUST-002,Apex Fine Dining Group,procurement@apexdining.co.uk,12 Commercial Way,Manchester,M1 4ET
CUST-003,The Highland Bistro,orders@highlandbistro.co.uk,44 Castle Street,Edinburgh,EH1 2NG
CUST-004,Bayside Fish & Grill,supplies@baysidegrill.com,8 Ocean Parade,Brighton,BN1 1AE
CUST-005,Riverside Artisan Bakery,bake@riversidebakery.co.uk,22 River Lane,Bristol,BS1 6XN
CUST-006,Metropolitan Hotel Supplies,purchasing@metrohotel.com,100 Kingsway,London,W1A 1AA
`;

  const productsCsv = `sku,description,unit,pack_size,default_price,tax_rate
GL1001,Nitrile Gloves Blue Medium (Box 100),box,100,4.50,0.20
GL1002,Nitrile Gloves Black Large (Box 100),box,100,5.20,0.20
GL1003,Vinyl Gloves Clear Small (Box 100),box,100,3.80,0.20
PAP-01,Paper Cups 8oz Single Wall (Case 1000),case,1000,32.00,0.20
PAP-02,Paper Cups 12oz Eco Kraft (Pack 500),pack,500,28.00,0.20
COF-88,Arabica Espresso Coffee Beans 1kg Bag,bag,1,14.50,0.00
COF-90,Fairtrade Filter Coffee Grounds 1kg,bag,1,12.00,0.00
NAP-33,Luxury Linen Feel White Napkins (Box 1000),box,1000,34.00,0.20
NAP-10,Standard 2-Ply Lunch Napkins (Case 2000),case,2000,22.50,0.20
ROLL-01,Catering Foil 450mm x 75m Dispenser,roll,1,11.50,0.20
ROLL-02,Cling Film 450mm x 300m Dispenser,roll,1,13.20,0.20
CLEAN-10,Multi-Surface Sanitizer 5L,can,1,16.20,0.20
DEG-05,Heavy Duty Kitchen Degreaser 5L,can,1,19.80,0.20
`;

  for (const dir of outDirs) {
    fs.writeFileSync(path.join(dir, 'customers_import.csv'), customerCsv, 'utf8');
    fs.writeFileSync(path.join(dir, 'products_import.csv'), productsCsv, 'utf8');
  }
}

async function main() {
  for (const dir of outDirs) {
    await generateCustomerPo1(path.join(dir, 'PO_Example_Cafe_Order.pdf'));
    await generateCustomerPo2(path.join(dir, 'PO_Apex_Dining_Order.pdf'));
    await generateProductCataloguePdf(path.join(dir, 'Product_Catalogue.pdf'));
    await generateCustomerListPdf(path.join(dir, 'Customer_Directory.pdf'));
  }
  generateCsvFiles();
  console.log('Successfully generated all sample PDFs and CSVs in:');
  console.log(outDirs.join('\n'));
}

main().catch(console.error);
