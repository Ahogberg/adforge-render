import { config } from './config.js';
import type { Prospect } from './types.js';

export interface SendResult { messageId?: string; dryRun: boolean }

export async function sendProspectEmail(prospect: Prospect): Promise<SendResult> {
  if (!prospect.preview) throw new Error('Generate a Campaign Preview before outreach');
  if (!prospect.input.contactEmail) throw new Error('A verified business email is required');
  if (prospect.status !== 'approved') throw new Error('Operator approval is required before sending');
  if (prospect.sentAt || prospect.providerMessageId) throw new Error('This outreach has already been sent');
  if (!config.resendKey || !config.outreachFrom) return { dryRun: true };

  const previewUrl = `${config.publicUrl}/preview/${prospect.previewToken}`;
  const unsubscribeUrl = `${config.publicUrl}/unsubscribe/${prospect.previewToken}`;
  const oneClickUnsubscribeUrl = `${config.publicUrl}/api/unsubscribe/${prospect.previewToken}`;
  const body = `${prospect.preview.outreachBody}\n\nCampaign Preview: ${previewUrl}\n\nIf this is not relevant, opt out here: ${unsubscribeUrl}`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.resendKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `adforge-prospect-${prospect.id}`,
    },
    body: JSON.stringify({
      from: config.outreachFrom,
      to: [prospect.input.contactEmail],
      reply_to: config.outreachReplyTo || undefined,
      subject: prospect.preview.outreachSubject,
      text: body,
      headers: {
        'List-Unsubscribe': `<${oneClickUnsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }),
  });
  const payload = await response.json() as { id?: string; message?: string };
  if (!response.ok || !payload.id) throw new Error(payload.message || `Email provider rejected the request (${response.status})`);
  return { messageId: payload.id, dryRun: false };
}
