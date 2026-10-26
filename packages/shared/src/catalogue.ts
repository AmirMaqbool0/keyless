import { z } from 'zod';

export type ProductDto = {
  id: string;
  sku: string;
  description: string;
  uom: string | null;
  packSize: number | null;
  barcode: string | null;
  defaultPrice: number | null;
  stockQty: number | null;
  active: boolean;
  source: 'import' | 'connector' | 'manual';
  updatedAt: string;
};

export type Address = {
  label?: string | null;
  line1: string;
  line2?: string | null;
  city?: string | null;
  postcode?: string | null;
  country?: string | null;
};

export type CustomerDto = {
  id: string;
  accountCode: string;
  name: string;
  erpCustomerId: string | null;
  emailDomains: string[];
  senderAddresses: string[];
  deliveryAddresses: Address[];
  priceListCode: string | null;
  creditHold: boolean;
  trustedForAutoApprove: boolean;
  source: 'import' | 'connector' | 'manual';
  crossReferenceCount?: number;
  updatedAt: string;
};

export type CustomerPriceDto = {
  id: string;
  sku: string;
  price: number;
  currency: string;
  customerId: string | null;
  priceListCode: string | null;
  minQty: number | null;
  validFrom: string | null;
  validTo: string | null;
};

export type CrossReferenceDto = {
  id: string;
  customerId: string;
  customerName: string | null;
  customerPartCode: string | null;
  customerDescription: string | null;
  sku: string;
  productDescription: string | null;
  customerUom: string | null;
  uomFactor: number;
  source: 'import' | 'learned' | 'manual';
  confidence: number;
  timesUsed: number;
  lastUsedAt: string | null;
  updatedAt: string;
};

export type Paginated<T> = { items: T[]; total: number; page: number; pageSize: number };

export const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const emailListSchema = z.array(z.string().trim().toLowerCase().pipe(z.email())).max(200);
const domainListSchema = z
  .array(
    z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter a domain like example.co.uk'),
  )
  .max(50);

export const updateCustomerSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    emailDomains: domainListSchema,
    senderAddresses: emailListSchema,
    priceListCode: z.string().trim().max(50).nullable(),
    creditHold: z.boolean(),
    trustedForAutoApprove: z.boolean(),
    deliveryAddresses: z
      .array(
        z.object({
          label: z.string().trim().max(100).nullish(),
          line1: z.string().trim().min(1).max(200),
          line2: z.string().trim().max(200).nullish(),
          city: z.string().trim().max(100).nullish(),
          postcode: z.string().trim().max(20).nullish(),
          country: z.string().trim().max(60).nullish(),
        }),
      )
      .max(100),
  })
  .partial();
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const CONNECTOR_TYPES = [
  'mock',
  'csv_export',
  'unleashed',
  'cin7_core',
  'quickbooks_online',
] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export type SyncResult = {
  entity: 'products' | 'customers' | 'prices' | 'stock';
  created: number;
  updated: number;
  deactivated: number;
  errors: string[];
  durationMs: number;
};

export type ConnectorDto = {
  id: string;
  type: ConnectorType;
  name: string;
  status: 'connected' | 'error' | 'disconnected';
  isDefault: boolean;
  lastSyncAt: string | null;
  lastSyncResults: SyncResult[];
  lastError: string | null;
  createdAt: string;
};
