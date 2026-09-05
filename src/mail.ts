import { config } from './config.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

export interface MailResult { id?: string; dryRun: boolean }

/** True when the engine can actually deliver email instead of recording a dry run. */
export function isMailLive(): boolean {
  return Boolean(config.resendKey && config.outreachFrom);
}

/**
 * Sends one plain-text email through Resend. Without provider credentials the
 * call is a safe dry run so every flow stays exercisable locally and in tests.
 */
export async function sendMail(message: MailMessage): Promise<MailResult> {
  if (!isMailLive()) return { dryRun: true };
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.resendKey}`,
    'Content-Type': 'application/json',
  };
  if (message.idempotencyKey) headers['Idempotency-Key'] = message.idempotencyKey;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from: config.outreachFrom,
      to: [message.to],
      reply_to: message.replyTo || config.outreachReplyTo || undefined,
      subject: message.subject,
      text: message.text,
      headers: message.headers,
    }),
  });
  const payload = await response.json().catch(() => ({})) as { id?: string; message?: string };
  if (!response.ok || !payload.id) throw new Error(payload.message || `Email provider rejected the request (${response.status})`);
  return { id: payload.id, dryRun: false };
}
