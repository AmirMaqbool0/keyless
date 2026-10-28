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

export type QuickBooksCredentials = {
  realmId: string;
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  baseUrl?: string;
};

/**
 * QuickBooks Online REST API integration (spec section 10).
 * Official Auth: OAuth 2.0 Bearer token per realmId (Company ID).
 * Note: QBO maps sales orders to 'Estimate' (or 'Invoice') configurable via connector settings.
 */
export class QuickBooksOnlineConnector implements OrderConnector {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly ctx: ConnectorContext,
    deps?: { fetch?: FetchLike },
  ) {
    this.baseUrl =
      (ctx.connector.settings?.baseUrl as string) || 'https://quickbooks.api.intuit.com/v3/company';
    this.fetchImpl = deps?.fetch ?? (fetch as unknown as FetchLike);
  }

  private credentials(): QuickBooksCredentials {
    if (!this.ctx.connector.credentialsEnc) {
      throw new Error('QuickBooks Online credentials are not configured');
    }
    return JSON.parse(decrypt(this.ctx.connector.credentialsEnc)) as QuickBooksCredentials;
  }

  private get documentType(): 'Estimate' | 'Invoice' {
    return (this.ctx.connector.settings?.documentType as 'Estimate' | 'Invoice') || 'Estimate';
  }

  private async request<T>(
    endpoint: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const creds = this.credentials();
    const url = `${this.baseUrl}/${creds.realmId}${endpoint}`;

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${creds.accessToken}`,
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
      throw new Error(`QuickBooks API error (${res.status}): ${errText || res.statusText}`);
    }

    return (await res.json()) as T;
  }

  async testConnection(): Promise<ConnectionResult> {
    try {
      const creds = this.credentials();
      await this.request<{ CompanyInfo?: unknown }>(`/companyinfo/${creds.realmId}`);
      return { ok: true, message: 'Connected to QuickBooks Online successfully' };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async syncCustomers(): Promise<SyncResult> {
    const started = Date.now();
    try {
      // TODO(verify-api): Confirm QBO query pagination limit and syntax
      const res = await this.request<{
        QueryResponse?: {
          Customer?: Array<{
            Id: string;
            DisplayName: string;
            PrimaryEmailAddr?: { Address?: string };
            BillAddr?: {
              Line1?: string;
              City?: string;
              PostalCode?: string;
              Country?: string;
            };
            Active?: boolean;
          }>;
        };
      }>('/query?query=select * from Customer maxresults 250');

      const items = res.QueryResponse?.Customer ?? [];
      const customers = items.map((c) => ({
        accountCode: c.DisplayName || c.Id,
        name: c.DisplayName,
        senderAddresses: c.PrimaryEmailAddr?.Address ? [c.PrimaryEmailAddr.Address] : [],
        creditHold: false,
        deliveryAddresses: c.BillAddr?.Line1
          ? [
              {
                line1: c.BillAddr.Line1,
                city: c.BillAddr.City,
                postcode: c.BillAddr.PostalCode,
                country: c.BillAddr.Country,
              },
            ]
          : [],
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
        QueryResponse?: {
          Item?: Array<{
            Id: string;
            Name: string;
            Description?: string;
            UnitPrice?: number;
            QtyOnHand?: number;
            Active?: boolean;
          }>;
        };
      }>('/query?query=select * from Item maxresults 250');

      const items = res.QueryResponse?.Item ?? [];
      const products = items.map((p) => ({
        sku: p.Name,
        description: p.Description || p.Name,
        defaultPrice: p.UnitPrice,
        stockQty: p.QtyOnHand,
        active: p.Active ?? true,
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
      const docType = this.documentType;
      // TODO(verify-api): Confirm DocNumber escaping in QBO query syntax
      const res = await this.request<{
        QueryResponse?: Record<string, Array<{ Id: string; DocNumber?: string; MetaData?: { CreateTime?: string } }>>;
      }>(`/query?query=select * from ${docType} where DocNumber = '${poNumber.replace(/'/g, "\\'")}'`);

      const list = res.QueryResponse?.[docType];
      const match = list?.[0];
      return match
        ? { reference: match.DocNumber ?? match.Id, createdAt: match.MetaData?.CreateTime }
        : null;
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
      const docType = this.documentType;
      const endpoint = `/${docType.toLowerCase()}`;

      // TODO(verify-api): Verify ItemRef vs Description-only lines in QBO Estimate/Invoice
      const payload = {
        DocNumber: order.poNumber,
        CustomerRef: {
          name: order.customerRef,
        },
        TxnDate: order.orderDate ?? new Date().toISOString().slice(0, 10),
        CustomerMemo: {
          value: order.notes,
        },
        ShipAddr: order.deliveryAddress
          ? {
              Line1: order.deliveryAddress.line1,
              City: order.deliveryAddress.city,
              PostalCode: order.deliveryAddress.postcode,
              Country: order.deliveryAddress.country,
            }
          : undefined,
        Line: order.lines.map((l) => ({
          DetailType: 'SalesItemLineDetail',
          Amount: Number(((l.unitPrice ?? 0) * l.quantity).toFixed(2)),
          Description: l.description,
          SalesItemLineDetail: {
            ItemRef: {
              name: l.sku,
            },
            Qty: l.quantity,
            UnitPrice: l.unitPrice,
          },
        })),
      };

      const res = await this.request<Record<string, { Id?: string; DocNumber?: string }>>(endpoint, {
        method: 'POST',
        body: payload,
      });

      const doc = res[docType];
      const reference = doc?.DocNumber ?? doc?.Id ?? `QBO-${order.poNumber}`;
      return { ok: true, reference, alreadyExisted: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = message.includes('50') || message.includes('429') || message.includes('timeout');
      return { ok: false, error: message, retryable };
    }
  }
}
