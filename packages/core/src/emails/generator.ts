import type { IOrder } from '../models/Order';
import type { ICustomer } from '../models/Customer';
import type { IOrganization } from '../models/Organization';

export type DraftEmail = {
  to: string;
  subject: string;
  body: string;
};

export function generateAcknowledgmentDraft(
  order: IOrder,
  customer: ICustomer | null,
  org: IOrganization | null,
  fallbackTo?: string,
): DraftEmail {
  const customerName = customer?.name ?? order.customerMatch.name ?? 'Valued Customer';
  const orgName = org?.name ?? 'Our';
  const to = customer?.senderAddresses?.[0] ?? fallbackTo ?? '';
  const poNumber = order.poNumber || 'your order';

  const linesText = order.lines
    .map(
      (l) =>
        `- ${l.sku ? `[${l.sku}] ` : ''}${l.productDescription || l.description || 'Item'} x ${l.quantity ?? 1} ${l.unit ?? ''}${l.lineTotal ? ` (£${l.lineTotal.toFixed(2)})` : ''}`,
    )
    .join('\n');

  const address = order.deliveryAddress?.line1
    ? [
        order.deliveryAddress.line1,
        order.deliveryAddress.line2,
        order.deliveryAddress.city,
        order.deliveryAddress.postcode,
      ]
        .filter(Boolean)
        .join(', ')
    : 'Default account address';

  const body = `Dear ${customerName},

Thank you for your purchase order ${poNumber}. We are pleased to confirm that your order has been accepted and is now being processed.

Order Details:
- Purchase Order: ${poNumber}
- Order Date: ${order.orderDate || 'Today'}
- Requested Delivery: ${order.requestedDeliveryDate || 'Standard delivery'}
- Delivery Address: ${address}

Items Ordered:
${linesText}

Total Value: ${order.currency || 'GBP'} ${order.value ? order.value.toFixed(2) : (order.documentTotals.total?.toFixed(2) ?? 'TBD')}

If you have any questions or require any adjustments, please reply to this email.

Kind regards,
${orgName} Order Processing Team`;

  return {
    to,
    subject: `Order Confirmation - PO ${poNumber}`,
    body,
  };
}

export function generateClarificationDraft(
  order: IOrder,
  customer: ICustomer | null,
  org: IOrganization | null,
  fallbackTo?: string,
): DraftEmail {
  const customerName = customer?.name ?? order.customerMatch.name ?? 'Valued Customer';
  const orgName = org?.name ?? 'Our';
  const to = customer?.senderAddresses?.[0] ?? fallbackTo ?? '';
  const poNumber = order.poNumber || 'your recent purchase order';

  const unresolvedIssues = order.issues.filter((i) => !i.resolved && i.severity !== 'info');
  const issuesList = unresolvedIssues.length
    ? unresolvedIssues.map((i) => `- ${i.message}`).join('\n')
    : '- Price or product code confirmation required.';

  const body = `Dear ${customerName},

Thank you for sending purchase order ${poNumber}.

Before we can finalise and release your order into our warehouse system, we require quick clarification on the following item(s):

${issuesList}

Could you please reply to this message confirming how you would like us to proceed?

Kind regards,
${orgName} Order Processing Team`;

  return {
    to,
    subject: `Clarification needed: PO ${poNumber}`,
    body,
  };
}
