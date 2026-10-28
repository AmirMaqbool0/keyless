import { logger } from './logger';

export type MailMessage = { to: string; subject: string; text: string; html?: string };
export type SentMail = MailMessage & { id: number; sentAt: string };

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/**
 * Development mailer: logs each email and keeps the last 100 in memory so they can be
 * read at /dev/emails in the web app. Real providers (Postmark etc.) plug in behind `Mailer`.
 */
export class ConsoleMailer implements Mailer {
  readonly outbox: SentMail[] = [];
  private nextId = 1;

  async send(message: MailMessage): Promise<void> {
    const mail = { ...message, id: this.nextId++, sentAt: new Date().toISOString() };
    this.outbox.unshift(mail);
    this.outbox.splice(100);
    logger.info({ to: message.to }, `[mail] ${message.subject}\n${message.text}`);
  }
}

/**
 * Resend mailer: sends live emails via the Resend REST API (https://resend.com).
 */
export class ResendMailer implements Mailer {
  readonly outbox: SentMail[] = [];
  private nextId = 1;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const mail: SentMail = { ...message, id: this.nextId++, sentAt: new Date().toISOString() };
    this.outbox.unshift(mail);
    this.outbox.splice(100);

    const payload: {
      from: string;
      to: string | string[];
      subject: string;
      text: string;
      html?: string;
    } = {
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    };
    if (message.html) {
      payload.html = message.html;
    }

    logger.info({ to: message.to, subject: message.subject }, '[mail:resend] Sending email via Resend API');

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errBody = await res.text();
      logger.error({ status: res.status, err: errBody, to: message.to }, '[mail:resend] Send failed');
      throw new Error(`Resend API error (${res.status}): ${errBody}`);
    }

    const data = (await res.json()) as { id?: string };
    logger.info({ to: message.to, resendId: data.id }, '[mail:resend] Email sent successfully');
  }
}

