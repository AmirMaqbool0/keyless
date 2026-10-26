import { Router } from 'express';
import type { Types } from 'mongoose';
import Papa from 'papaparse';
import { z } from 'zod';
import { listQuerySchema, updateCustomerSchema, type Paginated } from '@keyless/shared';
import { audit } from '@keyless/core/lib/audit';
import { notFound, param, validate } from '@keyless/core/lib/http';
import { escapeRegex, searchText, skuKey, tokenFilter } from '@keyless/core/lib/normalise';
import { authed, requireRole } from '../../middleware/auth';
import { CrossReference, type ICrossReference } from '@keyless/core/models/CrossReference';
import { Customer } from '@keyless/core/models/Customer';
import { CustomerPrice } from '@keyless/core/models/CustomerPrice';
import { Product } from '@keyless/core/models/Product';
import { objectId } from '../shared';
import { toCrossReferenceDto, toCustomerDto, toPriceDto, toProductDto } from './dto';

const productQuery = listQuerySchema.extend({
  active: z.enum(['true', 'false', 'all']).default('all'),
});
const crossRefQuery = listQuerySchema.extend({
  customerId: z.string().optional(),
  source: z.enum(['import', 'learned', 'manual']).optional(),
});

function page<T>(items: T[], total: number, q: { page: number; pageSize: number }): Paginated<T> {
  return { items, total, page: q.page, pageSize: q.pageSize };
}

/** Attach customer names and product descriptions to a page of cross-references. */
async function crossRefDtos(orgId: Types.ObjectId, rows: ICrossReference[]) {
  const [customers, products] = await Promise.all([
    Customer.find(
      { orgId, _id: { $in: [...new Set(rows.map((r) => r.customerId.toString()))] } },
      { name: 1 },
    ).lean(),
    Product.find(
      { orgId, skuKey: { $in: [...new Set(rows.map((r) => r.skuKey))] } },
      { skuKey: 1, description: 1 },
    ).lean(),
  ]);
  const names = new Map(customers.map((c) => [c._id.toString(), c.name]));
  const descriptions = new Map(products.map((p) => [p.skuKey, p.description]));
  return rows.map((x) =>
    toCrossReferenceDto(x, {
      customerName: names.get(x.customerId.toString()),
      productDescription: descriptions.get(x.skuKey),
    }),
  );
}

/** Mounted behind requireAuth + requireVerified. Reads for every role; writes for admins. */
export function catalogueRouter(): Router {
  const r = Router();

  // ---- Products ----
  r.get('/products', async (req, res) => {
    const { orgId } = authed(req);
    const q = validate(productQuery, req.query);
    const filter = {
      orgId,
      ...(q.active === 'all' ? {} : { active: q.active === 'true' }),
      ...tokenFilter('searchText', q.q),
    };
    const [rows, total] = await Promise.all([
      Product.find(filter)
        .sort({ skuKey: 1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize),
      Product.countDocuments(filter),
    ]);
    // An exact SKU/barcode hit always comes first.
    if (q.q && q.page === 1) {
      const exact = await Product.findOne({
        orgId,
        $or: [{ skuKey: skuKey(q.q) }, { barcode: q.q.trim() }],
      });
      if (exact) {
        const rest = rows.filter((p) => !p._id.equals(exact._id));
        rows.splice(0, rows.length, exact, ...rest.slice(0, q.pageSize - 1));
      }
    }
    res.json(page(rows.map(toProductDto), total, q));
  });

  r.get('/products/:id', async (req, res) => {
    const { orgId } = authed(req);
    const product = await Product.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!product) throw notFound('Product not found');
    const crossReferences = await CrossReference.countDocuments({ orgId, skuKey: product.skuKey });
    res.json({ product: toProductDto(product), crossReferences });
  });

  // ---- Customers ----
  r.get('/customers', async (req, res) => {
    const { orgId } = authed(req);
    const q = validate(listQuerySchema, req.query);
    const term = q.q?.toLowerCase();
    const filter = {
      orgId,
      ...(term
        ? {
            $or: [
              tokenFilter('searchText', term),
              { senderAddresses: term },
              { emailDomains: term.replace(/^.*@/, '') },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      Customer.find(filter)
        .sort({ name: 1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize),
      Customer.countDocuments(filter),
    ]);
    const counts = await CrossReference.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { orgId, customerId: { $in: rows.map((c) => c._id) } } },
      { $group: { _id: '$customerId', n: { $sum: 1 } } },
    ]);
    const countMap = new Map(counts.map((c) => [c._id.toString(), c.n]));
    res.json(
      page(
        rows.map((c) => toCustomerDto(c, countMap.get(c._id.toString()) ?? 0)),
        total,
        q,
      ),
    );
  });

  r.get('/customers/:id', async (req, res) => {
    const { orgId } = authed(req);
    const customer = await Customer.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!customer) throw notFound('Customer not found');
    const [crossReferences, prices] = await Promise.all([
      CrossReference.countDocuments({ orgId, customerId: customer._id }),
      CustomerPrice.countDocuments({
        orgId,
        $or: [
          { customerId: customer._id },
          ...(customer.priceListCode ? [{ priceListCode: skuKey(customer.priceListCode) }] : []),
        ],
      }),
    ]);
    res.json({
      customer: toCustomerDto(customer, crossReferences),
      counts: { crossReferences, prices },
    });
  });

  r.patch('/customers/:id', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    const input = validate(updateCustomerSchema, req.body);
    const customer = await Customer.findOne({ _id: objectId(param(req, 'id')), orgId });
    if (!customer) throw notFound('Customer not found');
    const before = toCustomerDto(customer);
    customer.set(input);
    customer.searchText = searchText(customer.accountCode, customer.name);
    await customer.save();
    const changed = Object.keys(input).filter(
      (k) =>
        JSON.stringify(before[k as keyof typeof before]) !==
        JSON.stringify(input[k as keyof typeof input]),
    );
    await audit({
      orgId,
      action: 'customer.updated',
      entity: { type: 'customer', id: customer._id.toString() },
      summary: { accountCode: customer.accountCode, changed },
      req,
    });
    res.json({ customer: toCustomerDto(customer) });
  });

  r.get('/customers/:id/prices', async (req, res) => {
    const { orgId } = authed(req);
    const q = validate(listQuerySchema, req.query);
    const customer = await Customer.findOne(
      { _id: objectId(param(req, 'id')), orgId },
      { priceListCode: 1 },
    );
    if (!customer) throw notFound('Customer not found');
    const filter = {
      orgId,
      $or: [
        { customerId: customer._id },
        ...(customer.priceListCode ? [{ priceListCode: skuKey(customer.priceListCode) }] : []),
      ],
      ...(q.q ? { skuKey: { $regex: `^${escapeRegex(skuKey(q.q))}` } } : {}),
    };
    const [rows, total] = await Promise.all([
      CustomerPrice.find(filter)
        .sort({ skuKey: 1, minQty: 1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize),
      CustomerPrice.countDocuments(filter),
    ]);
    res.json(page(rows.map(toPriceDto), total, q));
  });

  // ---- Cross-references ----
  r.get('/cross-references', async (req, res) => {
    const { orgId } = authed(req);
    const q = validate(crossRefQuery, req.query);
    const filter = {
      orgId,
      ...(q.customerId ? { customerId: objectId(q.customerId) } : {}),
      ...(q.source ? { source: q.source } : {}),
      ...tokenFilter('searchText', q.q),
    };
    const [rows, total] = await Promise.all([
      CrossReference.find(filter)
        .sort({ updatedAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize),
      CrossReference.countDocuments(filter),
    ]);
    res.json(page(await crossRefDtos(orgId, rows), total, q));
  });

  r.get('/cross-references/export', async (req, res) => {
    const { orgId } = authed(req);
    const customers = await Customer.find({ orgId }, { accountCode: 1 }).lean();
    const accounts = new Map(customers.map((c) => [c._id.toString(), c.accountCode]));
    const rows: Record<string, string | number>[] = [];
    for await (const x of CrossReference.find({ orgId })
      .sort({ customerId: 1, matchKey: 1 })
      .lean()
      .cursor()) {
      rows.push({
        'Customer account code': accounts.get(x.customerId.toString()) ?? '',
        "Customer's part code": x.customerPartCode ?? '',
        "Customer's description": x.customerDescription ?? '',
        'Our SKU': x.sku,
        "Customer's unit": x.customerUom ?? '',
        'Unit conversion factor': x.uomFactor,
        Source: x.source,
        'Times used': x.timesUsed,
      });
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="keyless-cross-references.csv"');
    // BOM so Excel opens it as UTF-8.
    res.send(String.fromCharCode(0xfeff) + Papa.unparse(rows, { newline: '\r\n' }));
  });

  r.delete('/cross-references/:id', requireRole('admin'), async (req, res) => {
    const { orgId } = authed(req);
    const xref = await CrossReference.findOneAndDelete({ _id: objectId(param(req, 'id')), orgId });
    if (!xref) throw notFound('Cross-reference not found');
    await audit({
      orgId,
      action: 'cross_reference.deleted',
      entity: { type: 'cross_reference', id: xref._id.toString() },
      summary: {
        customerId: xref.customerId.toString(),
        code: xref.customerPartCode,
        sku: xref.sku,
      },
      req,
    });
    res.status(204).end();
  });

  // ---- Prices (all) ----
  r.get('/prices', async (req, res) => {
    const { orgId } = authed(req);
    const q = validate(listQuerySchema, req.query);
    const filter = {
      orgId,
      ...(q.q ? { skuKey: { $regex: `^${escapeRegex(skuKey(q.q))}` } } : {}),
    };
    const [rows, total] = await Promise.all([
      CustomerPrice.find(filter)
        .sort({ skuKey: 1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize),
      CustomerPrice.countDocuments(filter),
    ]);
    res.json(page(rows.map(toPriceDto), total, q));
  });

  return r;
}
