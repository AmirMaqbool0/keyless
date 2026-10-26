/** Ground truth for one fixture (fixtures/<name>/expected.json). */
export type ExpectedLine = {
  customerPartCode: string | null;
  description: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number | null;
  /** Our SKU this line should match to (scored from M5, when matching exists). */
  expectedSku: string | null;
};

export type ExpectedOrder = {
  customerName: string | null;
  accountNumber: string | null;
  poNumber: string | null;
  orderDate: string | null;
  requestedDeliveryDate: string | null;
  deliveryAddress: { line1: string | null; postcode: string | null };
  currency: string | null;
  totals: { subtotal: number | null; tax: number | null; total: number | null };
  lines: ExpectedLine[];
};

export type Fixture = {
  name: string;
  description: string;
  /** e.g. pdf, scanned, image, spreadsheet, csv, body, multi-order */
  tags: string[];
  orders: ExpectedOrder[];
};
