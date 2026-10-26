import { z } from 'zod';

export const IMPORT_TYPES = ['products', 'customers', 'prices', 'cross_references'] as const;
export const importTypeSchema = z.enum(IMPORT_TYPES);
export type ImportType = z.infer<typeof importTypeSchema>;

export type ImportFieldType = 'string' | 'number' | 'boolean' | 'date' | 'list';

export type ImportField = {
  key: string;
  label: string;
  type: ImportFieldType;
  required?: boolean;
  /** Lower-case header names (punctuation stripped) that auto-map to this field. */
  synonyms: string[];
  help?: string;
};

/**
 * Target fields per import type. The API validates against these; the web app renders the
 * column-mapping step from them. Keys are the normalised field names stored in the DB.
 */
export const IMPORT_FIELDS: Record<ImportType, ImportField[]> = {
  products: [
    {
      key: 'sku',
      label: 'SKU / product code',
      type: 'string',
      required: true,
      synonyms: [
        'sku',
        'code',
        'product code',
        'item code',
        'stock code',
        'part number',
        'item',
        'product id',
        'item number',
      ],
    },
    {
      key: 'description',
      label: 'Description',
      type: 'string',
      required: true,
      synonyms: [
        'description',
        'name',
        'product name',
        'item description',
        'title',
        'product description',
      ],
    },
    {
      key: 'uom',
      label: 'Unit of measure',
      type: 'string',
      synonyms: ['uom', 'unit', 'unit of measure', 'units', 'sell unit'],
    },
    {
      key: 'packSize',
      label: 'Pack size',
      type: 'number',
      synonyms: ['pack size', 'pack', 'pack qty', 'qty per pack', 'case size', 'inner'],
      help: 'Units in one pack, e.g. 100',
    },
    {
      key: 'barcode',
      label: 'Barcode (EAN/UPC)',
      type: 'string',
      synonyms: ['barcode', 'ean', 'upc', 'gtin', 'ean13'],
    },
    {
      key: 'defaultPrice',
      label: 'Default price',
      type: 'number',
      synonyms: [
        'price',
        'default price',
        'sell price',
        'list price',
        'unit price',
        'rrp',
        'sales price',
      ],
    },
    {
      key: 'stockQty',
      label: 'Stock on hand',
      type: 'number',
      synonyms: ['stock', 'qty', 'quantity', 'stock qty', 'on hand', 'free stock', 'available'],
    },
    {
      key: 'active',
      label: 'Active',
      type: 'boolean',
      synonyms: ['active', 'enabled', 'status', 'is active'],
      help: 'yes/no, true/false, 1/0, active/inactive',
    },
  ],
  customers: [
    {
      key: 'accountCode',
      label: 'Account code',
      type: 'string',
      required: true,
      synonyms: [
        'account code',
        'account',
        'account number',
        'acc code',
        'customer code',
        'account no',
        'customer id',
        'cust code',
      ],
    },
    {
      key: 'name',
      label: 'Customer name',
      type: 'string',
      required: true,
      synonyms: ['name', 'customer name', 'company', 'company name', 'customer', 'account name'],
    },
    {
      key: 'erpCustomerId',
      label: 'ERP customer ID',
      type: 'string',
      synonyms: ['erp id', 'erp customer id', 'external id', 'guid'],
    },
    {
      key: 'emailDomains',
      label: 'Email domains',
      type: 'list',
      synonyms: ['email domains', 'domains', 'domain', 'email domain'],
      help: 'Separate several with ; or ,',
    },
    {
      key: 'senderAddresses',
      label: 'Order sender emails',
      type: 'list',
      synonyms: [
        'email',
        'emails',
        'order email',
        'sender',
        'senders',
        'buyer email',
        'orders email',
        'email address',
      ],
    },
    {
      key: 'priceListCode',
      label: 'Price list code',
      type: 'string',
      synonyms: ['price list', 'price list code', 'pricelist', 'price band', 'price group'],
    },
    {
      key: 'creditHold',
      label: 'On credit hold',
      type: 'boolean',
      synonyms: ['credit hold', 'on hold', 'on stop', 'stop', 'hold'],
    },
    {
      key: 'addressLine1',
      label: 'Delivery address line 1',
      type: 'string',
      synonyms: ['address', 'address 1', 'address line 1', 'delivery address', 'street', 'addr1'],
    },
    {
      key: 'addressLine2',
      label: 'Delivery address line 2',
      type: 'string',
      synonyms: ['address 2', 'address line 2', 'addr2'],
    },
    {
      key: 'city',
      label: 'Town / city',
      type: 'string',
      synonyms: ['city', 'town', 'town city', 'locality'],
    },
    {
      key: 'postcode',
      label: 'Postcode',
      type: 'string',
      synonyms: ['postcode', 'post code', 'zip', 'postal code', 'zip code'],
    },
    { key: 'country', label: 'Country', type: 'string', synonyms: ['country', 'country code'] },
  ],
  prices: [
    {
      key: 'sku',
      label: 'SKU',
      type: 'string',
      required: true,
      synonyms: ['sku', 'code', 'product code', 'item code', 'stock code'],
    },
    {
      key: 'price',
      label: 'Price',
      type: 'number',
      required: true,
      synonyms: ['price', 'unit price', 'net price', 'contract price', 'sell price'],
    },
    {
      key: 'accountCode',
      label: 'Customer account code',
      type: 'string',
      synonyms: ['account code', 'account', 'customer code', 'account number', 'customer'],
      help: 'Either this or a price list code',
    },
    {
      key: 'priceListCode',
      label: 'Price list code',
      type: 'string',
      synonyms: ['price list', 'price list code', 'pricelist', 'price band'],
    },
    { key: 'currency', label: 'Currency', type: 'string', synonyms: ['currency', 'ccy'] },
    {
      key: 'minQty',
      label: 'Minimum quantity',
      type: 'number',
      synonyms: ['min qty', 'minimum qty', 'break qty', 'qty break', 'from qty'],
    },
    {
      key: 'validFrom',
      label: 'Valid from',
      type: 'date',
      synonyms: ['valid from', 'from', 'start date', 'effective from'],
    },
    {
      key: 'validTo',
      label: 'Valid to',
      type: 'date',
      synonyms: ['valid to', 'to', 'end date', 'expiry', 'expires'],
    },
  ],
  cross_references: [
    {
      key: 'accountCode',
      label: 'Customer account code',
      type: 'string',
      required: true,
      synonyms: ['account code', 'account', 'customer code', 'account number', 'customer'],
    },
    {
      key: 'customerPartCode',
      label: "Customer's part code",
      type: 'string',
      synonyms: [
        'customer part code',
        'customer code ref',
        'their code',
        'customer sku',
        'customer item code',
        'cust part',
        'customer part',
        'part code',
      ],
      help: 'This or a customer description is required',
    },
    {
      key: 'customerDescription',
      label: "Customer's description",
      type: 'string',
      synonyms: ['customer description', 'their description', 'customer item description'],
    },
    {
      key: 'sku',
      label: 'Our SKU',
      type: 'string',
      required: true,
      synonyms: ['sku', 'our sku', 'our code', 'product code', 'item code', 'stock code'],
    },
    {
      key: 'customerUom',
      label: "Customer's unit",
      type: 'string',
      synonyms: ['customer uom', 'customer unit', 'their unit'],
    },
    {
      key: 'uomFactor',
      label: 'Unit conversion factor',
      type: 'number',
      synonyms: ['factor', 'conversion', 'uom factor', 'conversion factor', 'multiplier'],
      help: 'Our units per 1 customer unit, e.g. 100',
    },
  ],
};

export const IMPORT_TYPE_LABELS: Record<ImportType, string> = {
  products: 'Products (catalogue)',
  customers: 'Customers',
  prices: 'Prices',
  cross_references: 'Cross-references',
};

/** field key -> CSV column header (or null for unmapped). */
export const importMappingSchema = z.record(z.string(), z.string().nullable());
export type ImportMapping = z.infer<typeof importMappingSchema>;

export type ImportRowError = { row: number; field?: string; message: string };

export type ImportJobDto = {
  id: string;
  type: ImportType;
  filename: string;
  status: 'uploaded' | 'validated' | 'completed' | 'failed';
  columns: string[];
  sampleRows: Record<string, string>[];
  mapping: ImportMapping;
  totals: {
    rows: number;
    valid: number;
    created: number;
    updated: number;
    skipped: number;
    errors: number;
  };
  errors: ImportRowError[];
  createdAt: string;
  completedAt: string | null;
  createdBy: string | null;
};

/** Normalise a header for synonym matching: lower-case, punctuation to spaces. */
export function normaliseHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Best-guess mapping from CSV headers to target fields. */
export function suggestMapping(type: ImportType, columns: string[]): ImportMapping {
  const used = new Set<string>();
  const mapping: ImportMapping = {};
  for (const field of IMPORT_FIELDS[type]) {
    const candidates = [
      normaliseHeader(field.key),
      normaliseHeader(field.label),
      ...field.synonyms,
    ];
    const match = columns.find((c) => !used.has(c) && candidates.includes(normaliseHeader(c)));
    mapping[field.key] = match ?? null;
    if (match) used.add(match);
  }
  return mapping;
}
