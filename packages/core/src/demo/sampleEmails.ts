import MailComposer from 'nodemailer/lib/mail-composer';
import type Mail from 'nodemailer/lib/mailer';
import PDFDocument from 'pdfkit';

/** Realistic test emails for development, demos and (from M4) the evaluation fixtures. */

export const SAMPLE_SCENARIOS = [
  'pdf_po',
  'csv_po',
  'body_order',
  'amendment',
  'cancellation',
  'quote_request',
  'delivery_query',
  'out_of_office',
] as const;
export type SampleScenario = (typeof SAMPLE_SCENARIOS)[number];

export type SampleLine = {
  code: string;
  description: string;
  quantity: number;
  unitPrice?: number;
};
export type SampleContext = {
  customerName: string;
  senderName: string;
  senderAddress: string;
  to: string;
  poNumber: string;
  deliveryAddress: string[];
  lines: SampleLine[];
};

const money = (n: number) => `£${n.toFixed(2)}`;

/** A simple but realistic one-page purchase order PDF (text layer, like most ERP output). */
export function purchaseOrderPdf(ctx: SampleContext): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: { Title: `Purchase Order ${ctx.poNumber}` },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text(ctx.customerName, { continued: false });
    doc.fontSize(10).fillColor('#555').text('Purchasing Department').moveDown();
    doc.fillColor('#000').fontSize(16).text('PURCHASE ORDER', { align: 'right' });
    doc.fontSize(10).text(`PO Number: ${ctx.poNumber}`, { align: 'right' });
    doc.text(`Date: ${new Date().toLocaleDateString('en-GB')}`, { align: 'right' }).moveDown();
    doc.fontSize(10).text('Deliver to:', { underline: true });
    for (const l of ctx.deliveryAddress) doc.text(l);
    doc.moveDown();

    const cols = [50, 140, 360, 420, 490];
    const y0 = doc.y;
    doc.font('Helvetica-Bold');
    ['Item code', 'Description', 'Qty', 'Unit price', 'Total'].forEach((h, i) =>
      doc.text(h, cols[i]!, y0),
    );
    doc.font('Helvetica');
    let y = y0 + 18;
    let total = 0;
    for (const line of ctx.lines) {
      const lineTotal = (line.unitPrice ?? 0) * line.quantity;
      total += lineTotal;
      doc.text(line.code, cols[0]!, y);
      doc.text(line.description, cols[1]!, y, { width: 210 });
      doc.text(String(line.quantity), cols[2]!, y);
      doc.text(line.unitPrice === undefined ? '' : money(line.unitPrice), cols[3]!, y);
      doc.text(line.unitPrice === undefined ? '' : money(lineTotal), cols[4]!, y);
      y += Math.max(18, doc.heightOfString(line.description, { width: 210 }) + 6);
    }
    doc.font('Helvetica-Bold').text(`Subtotal: ${money(total)}`, 380, y + 10);
    doc
      .font('Helvetica')
      .fontSize(9)
      .text('Please confirm receipt of this order.', 50, y + 50);
    doc.end();
  });
}

function csvPo(ctx: SampleContext): string {
  const rows = [
    ['PO Number', 'Item Code', 'Description', 'Qty', 'Unit Price'],
    ...ctx.lines.map((l) => [
      ctx.poNumber,
      l.code,
      l.description,
      String(l.quantity),
      l.unitPrice?.toFixed(2) ?? '',
    ]),
  ];
  return rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\r\n');
}

/** Build a raw RFC 822 message for a scenario. */
export async function sampleEmail(scenario: SampleScenario, ctx: SampleContext): Promise<Buffer> {
  const from = { name: ctx.senderName, address: ctx.senderAddress };
  const sign = `\n\nKind regards,\n${ctx.senderName}\n${ctx.customerName}`;
  const lineText = ctx.lines.map((l) => `${l.quantity} x ${l.code} ${l.description}`).join('\n');
  const base = { from, to: ctx.to, date: new Date() };

  const mail = (() => {
    switch (scenario) {
      case 'pdf_po':
        return {
          ...base,
          subject: `Purchase Order ${ctx.poNumber}`,
          text: `Hi,\n\nPlease find attached our purchase order ${ctx.poNumber}.${sign}`,
        };
      case 'csv_po':
        return {
          ...base,
          subject: `Order ${ctx.poNumber} - ${ctx.customerName}`,
          text: `Morning,\n\nOrder attached as a spreadsheet export.${sign}`,
          attachments: [
            { filename: `PO_${ctx.poNumber}.csv`, content: csvPo(ctx), contentType: 'text/csv' },
          ],
        };
      case 'body_order':
        return {
          ...base,
          subject: `Order for this week - ${ctx.poNumber}`,
          text: `Hi team,\n\nCould you please send the following:\n\n${lineText}\n\nDeliver to our usual address.${sign}`,
        };
      case 'amendment':
        return {
          ...base,
          subject: `RE: Purchase Order ${ctx.poNumber} - amendment`,
          text: `Hi,\n\nPlease amend our order ${ctx.poNumber}: change the quantity of ${ctx.lines[0]?.code ?? 'the first item'} to ${(ctx.lines[0]?.quantity ?? 1) + 5}.${sign}`,
        };
      case 'cancellation':
        return {
          ...base,
          subject: `Cancel order ${ctx.poNumber}`,
          text: `Hello,\n\nPlease cancel purchase order ${ctx.poNumber}, we no longer need it.${sign}`,
        };
      case 'quote_request':
        return {
          ...base,
          subject: 'Price request',
          text: `Hi,\n\nCould you price up the following for us please?\n\n${lineText}${sign}`,
        };
      case 'delivery_query':
        return {
          ...base,
          subject: `Where is our delivery? ${ctx.poNumber}`,
          text: `Hi,\n\nOur order ${ctx.poNumber} has not arrived yet - can you give us an ETA?${sign}`,
        };
      case 'out_of_office':
        return {
          ...base,
          subject: 'Automatic reply: Your invoice',
          text: `I am out of the office until Monday with limited access to email.`,
          headers: { 'Auto-Submitted': 'auto-replied' },
        };
    }
  })();

  const attachments: Mail.Attachment[] = [...(('attachments' in mail && mail.attachments) || [])];
  if (scenario === 'pdf_po') {
    attachments.push({
      filename: `PO-${ctx.poNumber}.pdf`,
      content: await purchaseOrderPdf(ctx),
      contentType: 'application/pdf',
    });
  }
  return new MailComposer({ ...mail, attachments }).compile().build();
}
