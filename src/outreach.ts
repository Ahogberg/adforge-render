import { config } from './config.js';
import type { Prospect } from './types.js';

export interface ComposedOutreach { to: string; subject: string; body: string }
export interface SendResult { messageId?: string; dryRun: boolean; email: ComposedOutreach }

/**
 * Cold outreach is sent manually from a warmed outreach mailbox by default.
 * Resend's acceptable use policy prohibits cold outreach, and a suspended Resend
 * account would also stop client review links and application confirmations.
 * Automatic sending through Resend is only possible with an explicit opt-in.
 */
export function outreachSendsAutomatically(): boolean {
  return Boolean(config.outreachViaResend && config.resendKey && config.outreachFrom);
}

export function composeOutreach(prospect: Prospect): ComposedOutreach {
  if (!prospect.preview) throw new Error('Generate a Campaign Preview before outreach');
  const previewUrl = `${config.publicUrl}/preview/${prospect.previewToken}`;
  const unsubscribeUrl = `${config.publicUrl}/unsubscribe/${prospect.previewToken}`;
  return {
    to: prospect.input.contactEmail,
    subject: prospect.preview.outreachSubject,
    body: `${prospect.preview.outreachBody}\n\nCampaign Preview: ${previewUrl}\n\nIf this is not relevant, opt out here: ${unsubscribeUrl}`,
  };
}

export function assertSendable(prospect: Prospect): void {
  if (!prospect.preview) throw new Error('Generate a Campaign Preview before outreach');
  if (!prospect.input.contactEmail) throw new Error('A verified business email is required');
  if (prospect.status !== 'approved') throw new Error('Operator approval is required before sending');
  if (prospect.sentAt || prospect.providerMessageId) throw new Error('This outreach has already been sent');
}

export async function sendProspectEmail(prospect: Prospect): Promise<SendResult> {
  assertSendable(prospect);
  const email = composeOutreach(prospect);
  if (!outreachSendsAutomatically()) return { dryRun: true, email };

  const oneClickUnsubscribeUrl = `${config.publicUrl}/api/unsubscribe/${prospect.previewToken}`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `adforge-prospect-${prospect.id}`,
    },
    body: JSON.stringify({
      from: config.outreachFrom,
      to: [email.to],
      reply_to: config.outreachReplyTo || undefined,
      subject: email.subject,
      text: email.body,
      headers: {
        'List-Unsubscribe': `<${oneClickUnsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });
  const payload = await response.json() as { id?: string; message?: string };
  if (!response.ok || !payload.id) throw new Error(payload.message || `Email provider rejected the request (${response.status})`);
  return { messageId: payload.id, dryRun: false, email };
}
