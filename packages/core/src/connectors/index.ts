import type { SyncResult } from '@keyless/shared';
import { badRequest } from '../lib/http';
import type { Storage } from '../lib/storage';
import type { FetchLike } from '../mailboxes/oauth';
import type { ConnectorDoc } from '../models/Connector';
import { Cin7CoreConnector } from './cin7Core';
import { CsvExportConnector } from './csvExport';
import { MockConnector } from './mock';
import { QuickBooksOnlineConnector } from './quickbooks';
import type { OrderConnector } from './types';
import { UnleashedConnector } from './unleashed';

/** Connector types that can be created in Keyless (spec section 10). */
export const AVAILABLE_CONNECTORS = [
  'mock',
  'csv_export',
  'unleashed',
  'cin7_core',
  'quickbooks_online',
] as const;

export type ConnectorDeps = { storage?: Storage; fetch?: FetchLike };

export function createConnector(connector: ConnectorDoc, deps?: ConnectorDeps): OrderConnector {
  const ctx = { orgId: connector.orgId, connector };
  switch (connector.type) {
    case 'mock':
      return new MockConnector(ctx);
    case 'csv_export':
      return new CsvExportConnector(ctx, { storage: deps?.storage });
    case 'unleashed':
      return new UnleashedConnector(ctx, { fetch: deps?.fetch });
    case 'cin7_core':
      return new Cin7CoreConnector(ctx, { fetch: deps?.fetch });
    case 'quickbooks_online':
      return new QuickBooksOnlineConnector(ctx, { fetch: deps?.fetch });
    default:
      throw badRequest(
        `The ${connector.type} connector is not available`,
        'CONNECTOR_UNAVAILABLE',
      );
  }
}

export const SYNC_ENTITIES = ['customers', 'products', 'prices', 'stock'] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

/**
 * Run syncs in dependency order (customers before prices) and record the outcome on the
 * connector. A failure in one entity is recorded and the rest still run.
 */
export async function runSync(
  connector: ConnectorDoc,
  entities: readonly SyncEntity[],
  deps?: ConnectorDeps,
): Promise<SyncResult[]> {
  const impl = createConnector(connector, deps);
  const results: SyncResult[] = [];
  const failures: string[] = [];
  for (const entity of SYNC_ENTITIES.filter((e) => entities.includes(e))) {
    const fn = {
      customers: impl.syncCustomers.bind(impl),
      products: impl.syncProducts.bind(impl),
      prices: impl.syncPrices?.bind(impl),
      stock: impl.syncStock?.bind(impl),
    }[entity];
    if (!fn) continue;
    const started = Date.now();
    try {
      results.push(await fn());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${entity}: ${message}`);
      results.push({
        entity,
        created: 0,
        updated: 0,
        deactivated: 0,
        errors: [message],
        durationMs: Date.now() - started,
      });
    }
  }
  connector.lastSyncAt = new Date();
  connector.lastSyncResults = results;
  connector.lastError = failures.length ? failures.join('; ') : undefined;
  connector.status = failures.length ? 'error' : 'connected';
  connector.consecutiveFailures = failures.length ? connector.consecutiveFailures + 1 : 0;
  await connector.save();
  return results;
}
