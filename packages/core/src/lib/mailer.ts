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
