import type { SyncResult } from '@keyless/shared';
import { badRequest } from '../lib/http';
import type { ConnectorDoc } from '../models/Connector';
import { MockConnector } from './mock';
import type { OrderConnector } from './types';

/** Connector types that can be created today. The rest arrive in M7. */
export const AVAILABLE_CONNECTORS = ['mock'] as const;

export function createConnector(connector: ConnectorDoc): OrderConnector {
  switch (connector.type) {
    case 'mock':
      return new MockConnector({ orgId: connector.orgId, connector });
    default:
      throw badRequest(
        `The ${connector.type} connector is not available yet`,
        'CONNECTOR_UNAVAILABLE',
      );
  }
}

export const SYNC_ENTITIES = ['customers', 'products', 'prices', 'stock'] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

/**
 * Run syncs in dependency order (customers before prices) and record the outcome on the
 * connector. A failure in one entity is recorded and the rest still run.
 * TODO(M3): run as a BullMQ job with retries instead of inside the request.
 */
export async function runSync(
  connector: ConnectorDoc,
  entities: readonly SyncEntity[],
): Promise<SyncResult[]> {
  const impl = createConnector(connector);
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
