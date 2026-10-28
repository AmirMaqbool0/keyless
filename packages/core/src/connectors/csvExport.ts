import Papa from 'papaparse';
import type { SyncResult } from '@keyless/shared';
import { createStorage, type Storage } from '../lib/storage';
import { CsvExportOrder } from '../models/CsvExportOrder';
import type {
  ConnectionResult,
  ConnectorContext,
  ExternalOrderRef,
  NormalisedOrder,
  OrderConnector,
  PushResult,
} from './types';

/**
 * Produces CSV exports per order (and batch exports) in a clean tabular format.
 * Makes Keyless immediately usable with any inventory/ERP system that can import CSV (spec section 10).
 */
export class CsvExportConnector implements OrderConnector {
  private readonly storage: Storage;

  constructor(
    private readonly ctx: ConnectorContext,
    deps?: { storage?: Storage },
  ) {
    this.storage = deps?.storage ?? createStorage();
  }

  async testConnection(): Promise<ConnectionResult> {
    return { ok: true, message: 'CSV export folder is active and ready for sales orders' };
  }

  async syncCustomers(): Promise<SyncResult> {
    return {
      entity: 'customers',
      created: 0,
      updated: 0,
      deactivated: 0,
      errors: [],
      durationMs: 0,
    };
  }

  async syncProducts(): Promise<SyncResult> {
    return {
      entity: 'products',
      created: 0,
      updated: 0,
      deactivated: 0,
      errors: [],
      durationMs: 0,
    };
  }

  async findExistingOrder(customerRef: string, poNumber: string): Promise<ExternalOrderRef | null> {
    const existing = await CsvExportOrder.findOne({
      orgId: this.ctx.orgId,
      connectorId: this.ctx.connector._id,
      customerRef,
      poNumber,
    });
    return existing
      ? { reference: existing.reference, createdAt: existing.createdAt.toISOString() }
      : null;
  }

  async createSalesOrder(order: NormalisedOrder, idempotencyKey: string): Promise<PushResult> {
    const { orgId, connector } = this.ctx;

    // 1. Idempotency check: if this order version was already exported, return previous reference.
    const existing = await CsvExportOrder.findOne({
      orgId,
      connectorId: connector._id,
      idempotencyKey,
    });
    if (existing) {
      return { ok: true, reference: existing.reference, alreadyExisted: true };
    }

    const count = await CsvExportOrder.countDocuments({ orgId, connectorId: connector._id });
    const reference = `CSV-${order.poNumber || 'ORD'}-${1001 + count}`;

    // 2. Generate CSV rows
    const rows = order.lines.map((l) => {
      const lineTotal = l.unitPrice !== undefined ? l.quantity * l.unitPrice : null;
      return {
        'Export Reference': reference,
        'PO Number': order.poNumber,
        'Customer Account': order.customerRef,
        'Order Date': order.orderDate ?? '',
        'Delivery Date': order.requestedDeliveryDate ?? '',
        'Currency': order.currency,
        'Line Number': l.lineNo,
        'SKU': l.sku,
        'Description': l.description ?? '',
        'Quantity': l.quantity,
        'Unit Price': l.unitPrice !== undefined ? Number(l.unitPrice.toFixed(2)) : '',
        'Line Total': lineTotal !== null ? Number(lineTotal.toFixed(2)) : '',
        'Delivery Line 1': order.deliveryAddress?.line1 ?? '',
        'Delivery City': order.deliveryAddress?.city ?? '',
        'Delivery Postcode': order.deliveryAddress?.postcode ?? '',
        'Notes': order.notes ?? '',
      };
    });

    const csvContent = Papa.unparse(rows, { header: true });
    const folder = (connector.settings?.folder as string) || 'exports';
    const storageKey = `${folder}/${orgId.toString()}/${connector._id.toString()}/${order.poNumber || 'order'}-${order.customerRef}.csv`;

    // 3. Save to storage
    await this.storage.put(storageKey, Buffer.from(csvContent, 'utf8'), 'text/csv');

    // 4. Save export log
    const totalValue = order.lines.reduce(
      (sum, l) => sum + (l.unitPrice !== undefined ? l.quantity * l.unitPrice : 0),
      0,
    );
    await CsvExportOrder.create({
      orgId,
      connectorId: connector._id,
      idempotencyKey,
      reference,
      customerRef: order.customerRef,
      poNumber: order.poNumber,
      storageKey,
      rowCount: order.lines.length,
      totalValue,
    });

    return { ok: true, reference, alreadyExisted: false };
  }
}
