import { Schema, type Query, type Aggregate } from 'mongoose';

/**
 * Tenant isolation, enforced in the data layer.
 *
 * Every tenant-owned schema uses this plugin. It adds a required, indexed `orgId` and makes
 * every query/aggregate fail closed unless its filter is scoped to an org. The orgId must
 * come from the authenticated session (`req.auth.orgId`), never from client input.
 *
 * A small number of system lookups legitimately cross tenants (login by email, lookups by
 * a hashed one-time token). Those pass `{ skipTenant: true }` explicitly so they are easy to
 * audit with a grep.
 */
export class TenantScopeError extends Error {
  constructor(modelName: string, op: string) {
    super(`Unscoped ${op} on tenant collection "${modelName}": filter must include orgId`);
  }
}

declare module 'mongoose' {
  interface MongooseQueryOptions {
    skipTenant?: boolean;
  }
}

const QUERY_OPS = [
  'countDocuments',
  'deleteMany',
  'deleteOne',
  'distinct',
  'estimatedDocumentCount',
  'find',
  'findOne',
  'findOneAndDelete',
  'findOneAndReplace',
  'findOneAndUpdate',
  'replaceOne',
  'updateMany',
  'updateOne',
] as const;

export function tenantScoped(schema: Schema): void {
  schema.add({
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  });

  for (const op of QUERY_OPS) {
    schema.pre(op, function (this: Query<unknown, unknown>) {
      if (this.getOptions().skipTenant) return;
      if (!this.getFilter().orgId) throw new TenantScopeError(this.model.modelName, op);
    });
  }

  schema.pre('aggregate', function (this: Aggregate<unknown>) {
    if (this.options.skipTenant) return;
    const first = this.pipeline()[0];
    const match =
      first && '$match' in first ? (first.$match as Record<string, unknown>) : undefined;
    if (!match?.orgId) {
      throw new TenantScopeError(this.model()?.modelName ?? 'unknown', 'aggregate');
    }
  });
}
