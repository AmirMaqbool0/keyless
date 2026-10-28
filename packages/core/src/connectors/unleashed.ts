import crypto from 'node:crypto';
import type { SyncResult } from '@keyless/shared';
import { upsertCustomers, upsertProducts } from '../catalogue/upsert';
import { decrypt } from '../lib/crypto';
import type { FetchLike } from '../mailboxes/oauth';
import type {
  ConnectionResult,
  ConnectorContext,
  ExternalOrderRef,
  NormalisedOrder,
  OrderConnector,
  PushResult,
} from './types';

export type UnleashedCredentials = {
  apiId: string;
  apiKey: string;
  baseUrl?: string;
};

/**
 * Unleashed Software REST API integration (spec section 10).
 * Official Auth: api-auth-id + api-auth-signature (HMAC-SHA256 of query string).
 */
export class UnleashedConnector implements OrderConnector {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly ctx: ConnectorContext,
    deps?: { fetch?: FetchLike },
  ) {
    this.baseUrl = (ctx.connector.settings?.baseUrl as string) || 'https://api.unleashedsoftware.com';
    this.fetchImpl = deps?.fetch ?? (fetch as unknown as FetchLike);
  }

  private credentials(): UnleashedCredentials {
    if (!this.ctx.connector.credentialsEnc) {
      throw new Error('Unleashed credentials are not configured');
    }
    return JSON.parse(decrypt(this.ctx.connector.credentialsEnc)) as UnleashedCredentials;
  }

  /**
   * Generates Unleashed HMAC-SHA256 signature from query string (or empty string for POST).
   * TODO(verify-api): Confirm whether Unleashed POST signatures include query parameters or empty string.
   */
  private signature(queryString: string, apiKey: string): string {
    return crypto.createHmac('sha256', apiKey).update(queryString).digest('base64');
  }

  private async request<T>(
    endpoint: string,
    options: { method?: string; query?: string; body?: unknown } = {},
  ): Promise<T> {
    const creds = this.credentials();
    const query = options.query ?? '';
    const sig = this.signature(query, creds.apiKey);
    const url = `${this.baseUrl}${endpoint}${query ? `?${query}` : ''}`;

    const headers: Record<string, string> = {
      'api-auth-id': creds.apiId,
      'api-auth-signature': sig,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    const res = await this.fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Unleashed API error (${res.status}): ${errText || res.statusText}`);
    }

    return (await res.json()) as T;
  }

  async testConnection(): Promise<ConnectionResult> {
    try {
      await this.request<{ Pagination?: { NumberOfItems: number } }>('/Customers', {
        query: 'pageSize=1',
      });
      return { ok: true, message: 'Connected to Unleashed successfully' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async syncCustomers(): Promise<SyncResult> {
    const started = Date.now();
    try {
      const res = await this.request<{
        Items?: Array<{
          CustomerCode: string;
          CustomerName: string;
          Email?: string;
          Addresses?: Array<{
            AddressType?: string;
            StreetAddress?: string;
            City?: string;
            PostalCode?: string;
            Country?: string;
          }>;
          StopCredit?: boolean;
        }>;
      }>('/Customers', { query: 'pageSize=200' });

      const items = res.Items ?? [];
      const customers = items.map((c) => ({
        accountCode: c.CustomerCode,
        name: c.CustomerName,
        senderAddresses: c.Email ? [c.Email] : [],
        creditHold: Boolean(c.StopCredit),
        deliveryAddresses: (c.Addresses ?? [])
          .filter((a) => (a.AddressType ?? '').toLowerCase().includes('delivery') || a.StreetAddress)
          .map((a) => ({
            line1: a.StreetAddress ?? '',
            city: a.City,
            postcode: a.PostalCode,
            country: a.Country,
          }))
          .filter((a) => a.line1),
      }));

      const upsertResult = await upsertCustomers(this.ctx.orgId, customers, 'connector');
      return {
        entity: 'customers',
        created: upsertResult.created,
        updated: upsertResult.updated,
        deactivated: 0,
        errors: [],
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        entity: 'customers',
        created: 0,
        updated: 0,
        deactivated: 0,
        errors: [err instanceof Error ? err.message : String(err)],
        durationMs: Date.now() - started,
      };
    }
  }

  async syncProducts(): Promise<SyncResult> {
    const started = Date.now();
    try {
      const res = await this.request<{
        Items?: Array<{
          ProductCode: string;
          ProductDescription: string;
          Barcode?: string;
          UnitOfMeasure?: { UnitOfMeasureName?: string };
          PackSize?: number;
          DefaultSellPrice?: number;
          Obsolete?: boolean;
        }>;
      }>('/Products', { query: 'pageSize=200' });

      const items = res.Items ?? [];
      const products = items.map((p) => ({
        sku: p.ProductCode,
        description: p.ProductDescription,
        barcode: p.Barcode,
        uom: p.UnitOfMeasure?.UnitOfMeasureName,
        packSize: p.PackSize && p.PackSize > 1 ? p.PackSize : undefined,
        defaultPrice: p.DefaultSellPrice,
        active: !p.Obsolete,
      }));

      const upsertResult = await upsertProducts(this.ctx.orgId, products, 'connector');
      return {
        entity: 'products',
        created: upsertResult.created,
        updated: upsertResult.updated,
        deactivated: 0,
        errors: [],
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        entity: 'products',
        created: 0,
        updated: 0,
        deactivated: 0,
        errors: [err instanceof Error ? err.message : String(err)],
        durationMs: Date.now() - started,
      };
    }
  }

  async findExistingOrder(customerRef: string, poNumber: string): Promise<ExternalOrderRef | null> {
    try {
      // TODO(verify-api): Confirm filter syntax for CustomerRef in Unleashed
      const query = `customerCode=${encodeURIComponent(customerRef)}&customerRef=${encodeURIComponent(poNumber)}`;
      const res = await this.request<{
        Items?: Array<{ OrderNumber: string; CreatedOn?: string }>;
      }>('/SalesOrders', { query });
      const first = res.Items?.[0];
      return first ? { reference: first.OrderNumber, createdAt: first.CreatedOn } : null;
    } catch {
      return null;
    }
  }

  async createSalesOrder(order: NormalisedOrder, _idempotencyKey: string): Promise<PushResult> {
    // 1. Check if order already exists in Unleashed before creating
    const existing = await this.findExistingOrder(order.customerRef, order.poNumber);
    if (existing) {
      return { ok: true, reference: existing.reference, alreadyExisted: true };
    }

    try {
      // TODO(verify-api): Confirm required fields for Unleashed SalesOrder lines
      const payload = {
        Customer: { CustomerCode: order.customerRef },
        CustomerRef: order.poNumber,
        OrderDate: order.orderDate ? new Date(order.orderDate).toISOString() : new Date().toISOString(),
        RequiredDate: order.requestedDeliveryDate
          ? new Date(order.requestedDeliveryDate).toISOString()
          : undefined,
        DeliveryStreet: order.deliveryAddress?.line1,
        DeliveryCity: order.deliveryAddress?.city,
        DeliveryPostCode: order.deliveryAddress?.postcode,
        Comments: order.notes,
        SalesOrderLines: order.lines.map((l) => ({
          LineNumber: l.lineNo,
          Product: { ProductCode: l.sku },
          OrderQuantity: l.quantity,
          UnitPrice: l.unitPrice,
        })),
      };

      const res = await this.request<{ OrderNumber?: string; Guid?: string }>('/SalesOrders', {
        method: 'POST',
        body: payload,
      });

      const reference = res.OrderNumber ?? res.Guid ?? `UL-${order.poNumber}`;
      return { ok: true, reference, alreadyExisted: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = message.includes('50') || message.includes('429') || message.includes('timeout');
      return { ok: false, error: message, retryable };
    }
  }
}
