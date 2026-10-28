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

export type Cin7Credentials = {
  accountId: string;
  applicationKey: string;
  baseUrl?: string;
};

/**
 * Cin7 Core (formerly DEAR Systems) REST API integration (spec section 10).
 * Official Auth: api-auth-accountid and api-auth-applicationkey headers.
 */
export class Cin7CoreConnector implements OrderConnector {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly ctx: ConnectorContext,
    deps?: { fetch?: FetchLike },
  ) {
    this.baseUrl =
      (ctx.connector.settings?.baseUrl as string) || 'https://inventory.dearsystems.com/ExternalApi/v2';
    this.fetchImpl = deps?.fetch ?? (fetch as unknown as FetchLike);
  }

  private credentials(): Cin7Credentials {
    if (!this.ctx.connector.credentialsEnc) {
      throw new Error('Cin7 Core credentials are not configured');
    }
    return JSON.parse(decrypt(this.ctx.connector.credentialsEnc)) as Cin7Credentials;
  }

  private async request<T>(
    endpoint: string,
    options: { method?: string; query?: string; body?: unknown } = {},
  ): Promise<T> {
    const creds = this.credentials();
    const query = options.query ? `?${options.query}` : '';
    const url = `${this.baseUrl}${endpoint}${query}`;

    const headers: Record<string, string> = {
      'api-auth-accountid': creds.accountId,
      'api-auth-applicationkey': creds.applicationKey,
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
      throw new Error(`Cin7 Core API error (${res.status}): ${errText || res.statusText}`);
    }

    return (await res.json()) as T;
  }

  async testConnection(): Promise<ConnectionResult> {
    try {
      await this.request<{ Total?: number }>('/customer', { query: 'page=1&limit=1' });
      return { ok: true, message: 'Connected to Cin7 Core successfully' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async syncCustomers(): Promise<SyncResult> {
    const started = Date.now();
    try {
      const res = await this.request<{
        CustomerList?: Array<{
          ID: string;
          Name: string;
          AccountReceivable?: string;
          Currency?: string;
          Status?: string;
          Addresses?: Array<{
            Line1?: string;
            City?: string;
            Postcode?: string;
            Country?: string;
            Type?: string;
          }>;
          ContactList?: Array<{ Email?: string }>;
        }>;
      }>('/customer', { query: 'page=1&limit=250' });

      const items = res.CustomerList ?? [];
      const customers = items.map((c) => ({
        accountCode: c.ID || c.Name,
        name: c.Name,
        senderAddresses: (c.ContactList ?? []).map((contact) => contact.Email).filter(Boolean) as string[],
        creditHold: c.Status === 'On Hold',
        deliveryAddresses: (c.Addresses ?? [])
          .filter((a) => a.Line1)
          .map((a) => ({
            line1: a.Line1 ?? '',
            city: a.City,
            postcode: a.Postcode,
            country: a.Country,
          })),
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
        Products?: Array<{
          ID: string;
          SKU: string;
          Name: string;
          Barcode?: string;
          UOM?: string;
          PriceTier1?: number;
          Status?: string;
        }>;
      }>('/product', { query: 'page=1&limit=250' });

      const items = res.Products ?? [];
      const products = items.map((p) => ({
        sku: p.SKU,
        description: p.Name,
        barcode: p.Barcode,
        uom: p.UOM,
        defaultPrice: p.PriceTier1,
        active: p.Status === 'Active',
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
      // TODO(verify-api): Confirm whether CustomerReference search returns exact or prefix matches in Cin7
      const res = await this.request<{
        SaleList?: Array<{ OrderNumber: string; CustomerReference?: string; Created?: string }>;
      }>('/saleList', { query: `Search=${encodeURIComponent(poNumber)}` });

      const match = res.SaleList?.find(
        (s) => s.CustomerReference?.toLowerCase() === poNumber.toLowerCase(),
      );
      return match ? { reference: match.OrderNumber, createdAt: match.Created } : null;
    } catch {
      return null;
    }
  }

  async createSalesOrder(order: NormalisedOrder, _idempotencyKey: string): Promise<PushResult> {
    const existing = await this.findExistingOrder(order.customerRef, order.poNumber);
    if (existing) {
      return { ok: true, reference: existing.reference, alreadyExisted: true };
    }

    try {
      // TODO(verify-api): Confirm payload mapping for Cin7 Core two-step sales order creation
      const payload = {
        Customer: order.customerRef,
        CustomerReference: order.poNumber,
        ShipToOther: Boolean(order.deliveryAddress?.line1),
        ShippingAddress: order.deliveryAddress
          ? {
              Line1: order.deliveryAddress.line1,
              City: order.deliveryAddress.city,
              Postcode: order.deliveryAddress.postcode,
              Country: order.deliveryAddress.country,
            }
          : undefined,
        Order: {
          Lines: order.lines.map((l) => ({
            SKU: l.sku,
            Quantity: l.quantity,
            Price: l.unitPrice,
            Comment: l.description,
          })),
        },
        Note: order.notes,
      };

      const res = await this.request<{ ID?: string; OrderNumber?: string }>('/sale', {
        method: 'POST',
        body: payload,
      });

      const reference = res.OrderNumber ?? res.ID ?? `CIN7-${order.poNumber}`;
      return { ok: true, reference, alreadyExisted: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = message.includes('50') || message.includes('429') || message.includes('timeout');
      return { ok: false, error: message, retryable };
    }
  }
}
