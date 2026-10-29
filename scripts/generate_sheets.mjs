import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'packages', 'core', 'package.json'));
const ExcelJS = require('exceljs');

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

// 1. Data Definitions
const customersData = [
  {
    accountCode: 'CUST-001',
    customerName: 'Example Cafe Ltd',
    orderEmail: 'orders@example-cafe.example',
    emailDomain: 'example-cafe.example',
    deliveryAddress: '1 High Street',
    city: 'Leeds',
    postcode: 'LS1 4AB',
    creditHold: 'No',
  },
  {
    accountCode: 'CUST-002',
    customerName: 'Apex Fine Dining Group',
    orderEmail: 'procurement@apexdining.co.uk',
    emailDomain: 'apexdining.co.uk',
    deliveryAddress: '12 Commercial Way',
    city: 'Manchester',
    postcode: 'M1 4ET',
    creditHold: 'No',
  },
  {
    accountCode: 'CUST-003',
    customerName: 'The Highland Bistro',
    orderEmail: 'orders@highlandbistro.co.uk',
    emailDomain: 'highlandbistro.co.uk',
    deliveryAddress: '44 Castle Street',
    city: 'Edinburgh',
    postcode: 'EH1 2NG',
    creditHold: 'No',
  },
  {
    accountCode: 'CUST-004',
    customerName: 'Bayside Fish & Grill',
    orderEmail: 'supplies@baysidegrill.com',
    emailDomain: 'baysidegrill.com',
    deliveryAddress: '8 Ocean Parade',
    city: 'Brighton',
    postcode: 'BN1 1AE',
    creditHold: 'No',
  },
  {
    accountCode: 'CUST-005',
    customerName: 'Riverside Artisan Bakery',
    orderEmail: 'bake@riversidebakery.co.uk',
    emailDomain: 'riversidebakery.co.uk',
    deliveryAddress: '22 River Lane',
    city: 'Bristol',
    postcode: 'BS1 6XN',
    creditHold: 'No',
  },
  {
    accountCode: 'CUST-006',
    customerName: 'Metropolitan Hotel Supplies',
    orderEmail: 'purchasing@metrohotel.com',
    emailDomain: 'metrohotel.com',
    deliveryAddress: '100 Kingsway',
    city: 'London',
    postcode: 'W1A 1AA',
    creditHold: 'No',
  },
];

const productsData = [
  {
    sku: 'GL1001',
    description: 'Nitrile Gloves Blue Medium (Box 100)',
    unit: 'box',
    packSize: 100,
    price: 4.50,
    barcode: '5012345678901',
    stock: 250,
    active: 'Yes',
  },
  {
    sku: 'GL1002',
    description: 'Nitrile Gloves Black Large (Box 100)',
    unit: 'box',
    packSize: 100,
    price: 5.20,
    barcode: '5012345678902',
    stock: 180,
    active: 'Yes',
  },
  {
    sku: 'GL1003',
    description: 'Vinyl Gloves Clear Small (Box 100)',
    unit: 'box',
    packSize: 100,
    price: 3.80,
    barcode: '5012345678903',
    stock: 320,
    active: 'Yes',
  },
  {
    sku: 'PAP-01',
    description: 'Paper Cups 8oz Single Wall (Case 1000)',
    unit: 'case',
    packSize: 1000,
    price: 32.00,
    barcode: '5012345678911',
    stock: 45,
    active: 'Yes',
  },
  {
    sku: 'PAP-02',
    description: 'Paper Cups 12oz Eco Kraft (Pack 500)',
    unit: 'pack',
    packSize: 500,
    price: 28.00,
    barcode: '5012345678912',
    stock: 60,
    active: 'Yes',
  },
  {
    sku: 'COF-88',
    description: 'Arabica Espresso Coffee Beans 1kg Bag',
    unit: 'bag',
    packSize: 1,
    price: 14.50,
    barcode: '5012345678921',
    stock: 110,
    active: 'Yes',
  },
  {
    sku: 'COF-90',
    description: 'Fairtrade Filter Coffee Grounds 1kg Bag',
    unit: 'bag',
    packSize: 1,
    price: 12.00,
    barcode: '5012345678922',
    stock: 95,
    active: 'Yes',
  },
  {
    sku: 'NAP-33',
    description: 'Luxury Linen Feel White Napkins (Box 1000)',
    unit: 'box',
    packSize: 1000,
    price: 34.00,
    barcode: '5012345678931',
    stock: 75,
    active: 'Yes',
  },
  {
    sku: 'NAP-10',
    description: 'Standard 2-Ply Lunch Napkins (Case 2000)',
    unit: 'case',
    packSize: 2000,
    price: 22.50,
    barcode: '5012345678932',
    stock: 140,
    active: 'Yes',
  },
  {
    sku: 'ROLL-01',
    description: 'Catering Foil 450mm x 75m Dispenser',
    unit: 'roll',
    packSize: 1,
    price: 11.50,
    barcode: '5012345678941',
    stock: 85,
    active: 'Yes',
  },
  {
    sku: 'ROLL-02',
    description: 'Cling Film 450mm x 300m Dispenser',
    unit: 'roll',
    packSize: 1,
    price: 13.20,
    barcode: '5012345678942',
    stock: 70,
    active: 'Yes',
  },
  {
    sku: 'CLEAN-10',
    description: 'Multi-Surface Food Grade Sanitizer 5L',
    unit: 'can',
    packSize: 1,
    price: 16.20,
    barcode: '5012345678951',
    stock: 50,
    active: 'Yes',
  },
  {
    sku: 'DEG-05',
    description: 'Heavy Duty Kitchen Degreaser 5L',
    unit: 'can',
    packSize: 1,
    price: 19.80,
    barcode: '5012345678952',
    stock: 40,
    active: 'Yes',
  },
];

// 2. CSV Generators
function generateCsvs(targetDir) {
  // Customers CSV
  const custHeader = ['Account Code', 'Customer Name', 'Order Email', 'Email Domain', 'Delivery Address', 'City', 'Postcode', 'Credit Hold'];
  const custRows = customersData.map(c => [
    `"${c.accountCode}"`,
    `"${c.customerName}"`,
    `"${c.orderEmail}"`,
    `"${c.emailDomain}"`,
    `"${c.deliveryAddress}"`,
    `"${c.city}"`,
    `"${c.postcode}"`,
    `"${c.creditHold}"`,
  ].join(','));
  const custCsv = [custHeader.join(','), ...custRows].join('\n') + '\n';
  fs.writeFileSync(path.join(targetDir, 'customers.csv'), custCsv, 'utf8');

  // Products CSV
  const prodHeader = ['SKU', 'Description', 'Unit', 'Pack Size', 'Default Price', 'Barcode', 'Stock', 'Active'];
  const prodRows = productsData.map(p => [
    `"${p.sku}"`,
    `"${p.description}"`,
    `"${p.unit}"`,
    p.packSize,
    p.price.toFixed(2),
    `"${p.barcode}"`,
    p.stock,
    `"${p.active}"`,
  ].join(','));
  const prodCsv = [prodHeader.join(','), ...prodRows].join('\n') + '\n';
  fs.writeFileSync(path.join(targetDir, 'products.csv'), prodCsv, 'utf8');
}

// 3. Excel (.xlsx) Generators
async function generateExcelFiles(targetDir) {
  // Customers XLSX
  const custWorkbook = new ExcelJS.Workbook();
  const custSheet = custWorkbook.addWorksheet('Customers');
  custSheet.columns = [
    { header: 'Account Code', key: 'accountCode', width: 16 },
    { header: 'Customer Name', key: 'customerName', width: 28 },
    { header: 'Order Email', key: 'orderEmail', width: 30 },
    { header: 'Email Domain', key: 'emailDomain', width: 24 },
    { header: 'Delivery Address', key: 'deliveryAddress', width: 25 },
    { header: 'City', key: 'city', width: 16 },
    { header: 'Postcode', key: 'postcode', width: 14 },
    { header: 'Credit Hold', key: 'creditHold', width: 14 },
  ];

  // Header style
  custSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  custSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
  custSheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

  for (const c of customersData) {
    custSheet.addRow(c);
  }
  await custWorkbook.xlsx.writeFile(path.join(targetDir, 'customers.xlsx'));

  // Products XLSX
  const prodWorkbook = new ExcelJS.Workbook();
  const prodSheet = prodWorkbook.addWorksheet('Products');
  prodSheet.columns = [
    { header: 'SKU', key: 'sku', width: 14 },
    { header: 'Description', key: 'description', width: 38 },
    { header: 'Unit', key: 'unit', width: 10 },
    { header: 'Pack Size', key: 'packSize', width: 12 },
    { header: 'Default Price', key: 'price', width: 15 },
    { header: 'Barcode', key: 'barcode', width: 18 },
    { header: 'Stock', key: 'stock', width: 12 },
    { header: 'Active', key: 'active', width: 10 },
  ];

  prodSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  prodSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F172A' } };
  prodSheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

  for (const p of productsData) {
    const row = prodSheet.addRow(p);
    row.getCell('price').numFmt = '£#,##0.00';
  }
  await prodWorkbook.xlsx.writeFile(path.join(targetDir, 'products.xlsx'));
}

async function main() {
  for (const dir of outDirs) {
    generateCsvs(dir);
    await generateExcelFiles(dir);
  }
  console.log('Successfully created CSV and Excel (.xlsx) files for Customers & Products in:');
  console.log(outDirs.join('\n'));
}

main().catch(console.error);
