import type { CrossReferenceDto, CustomerDto, CustomerPriceDto, ProductDto } from '@keyless/shared';
import type { ICrossReference } from '../../models/CrossReference';
import type { ICustomer } from '../../models/Customer';
import type { ICustomerPrice } from '../../models/CustomerPrice';
import type { IProduct } from '../../models/Product';

export function toProductDto(p: IProduct): ProductDto {
  return {
    id: p._id.toString(),
    sku: p.sku,
    description: p.description,
    uom: p.uom ?? null,
    packSize: p.packSize ?? null,
    barcode: p.barcode ?? null,
    defaultPrice: p.defaultPrice ?? null,
    stockQty: p.stockQty ?? null,
    active: p.active,
    source: p.source,
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toCustomerDto(c: ICustomer, crossReferenceCount?: number): CustomerDto {
  return {
    id: c._id.toString(),
    accountCode: c.accountCode,
    name: c.name,
    erpCustomerId: c.erpCustomerId ?? null,
    emailDomains: c.emailDomains,
    senderAddresses: c.senderAddresses,
    deliveryAddresses: c.deliveryAddresses.map((a) => ({
      label: a.label ?? null,
      line1: a.line1,
      line2: a.line2 ?? null,
      city: a.city ?? null,
      postcode: a.postcode ?? null,
      country: a.country ?? null,
    })),
    priceListCode: c.priceListCode ?? null,
    creditHold: c.creditHold,
    trustedForAutoApprove: c.trustedForAutoApprove,
    source: c.source,
    ...(crossReferenceCount === undefined ? {} : { crossReferenceCount }),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function toPriceDto(p: ICustomerPrice): CustomerPriceDto {
  return {
    id: p._id.toString(),
    sku: p.sku,
    price: p.price,
    currency: p.currency,
    customerId: p.customerId?.toString() ?? null,
    priceListCode: p.priceListCode ?? null,
    minQty: p.minQty ?? null,
    validFrom: p.validFrom?.toISOString().slice(0, 10) ?? null,
    validTo: p.validTo?.toISOString().slice(0, 10) ?? null,
  };
}

export function toCrossReferenceDto(
  x: ICrossReference,
  lookups: { customerName?: string; productDescription?: string },
): CrossReferenceDto {
  return {
    id: x._id.toString(),
    customerId: x.customerId.toString(),
    customerName: lookups.customerName ?? null,
    customerPartCode: x.customerPartCode ?? null,
    customerDescription: x.customerDescription ?? null,
    sku: x.sku,
    productDescription: lookups.productDescription ?? null,
    customerUom: x.customerUom ?? null,
    uomFactor: x.uomFactor,
    source: x.source,
    confidence: x.confidence,
    timesUsed: x.timesUsed,
    lastUsedAt: x.lastUsedAt?.toISOString() ?? null,
    updatedAt: x.updatedAt.toISOString(),
  };
}
