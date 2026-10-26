import type { Types } from 'mongoose';
import type { SyncResult } from '@keyless/shared';
import type { ConnectorDoc } from '../models/Connector';

export type ConnectionResult = { ok: boolean; message: string };

/** The order shape every connector receives. Refined in M7 when real pushes start. */
export type NormalisedOrder = {
  customerRef: string;
  poNumber: string;
  orderDate?: string;
  requestedDeliveryDate?: string;
  currency: string;
  deliveryAddress?: {
    line1: string;
    line2?: string;
    city?: string;
    postcode?: string;
    country?: string;
  };
  notes?: string;
  lines: {
    lineNo: number;
    sku: string;
    description?: string;
    quantity: number;
    unitPrice?: number;
  }[];
};

export type ExternalOrderRef = { reference: string; createdAt?: string };
export type PushResult =
  | { ok: true; reference: string; alreadyExisted: boolean }
  | { ok: false; error: string; retryable: boolean };

/** Spec section 10. Each ERP integration implements this. */
export interface OrderConnector {
  testConnection(): Promise<ConnectionResult>;
  syncCustomers(): Promise<SyncResult>;
  syncProducts(): Promise<SyncResult>;
  syncPrices?(): Promise<SyncResult>;
  syncStock?(): Promise<SyncResult>;
  createSalesOrder(order: NormalisedOrder, idempotencyKey: string): Promise<PushResult>;
  findExistingOrder?(customerRef: string, poNumber: string): Promise<ExternalOrderRef | null>;
}

export type ConnectorContext = { orgId: Types.ObjectId; connector: ConnectorDoc };
