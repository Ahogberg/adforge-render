import { config } from './config.js';
import { sendMail, type MailResult } from './mail.js';
import type { Prospect } from './types.js';

export type SendResult = MailResult;

export async function sendProspectEmail(prospect: Prospect): Promise<SendResult> {
  if (!prospect.preview) throw new Error('Generate a Campaign Preview before outreach');
  if (!prospect.input.contactEmail) throw new Error('A verified business email is required');
  if (prospect.status !== 'approved') throw new Error('Operator approval is required before sending');
  if (prospect.sentAt || prospect.providerMessageId) throw new Error('This outreach has already been sent');

  const previewUrl = `${config.publicUrl}/preview/${prospect.previewToken}`;
  const unsubscribeUrl = `${config.publicUrl}/unsubscribe/${prospect.previewToken}`;
  const oneClickUnsubscribeUrl = `${config.publicUrl}/api/unsubscribe/${prospect.previewToken}`;
  return sendMail({
    to: prospect.input.contactEmail,
    subject: prospect.preview.outreachSubject,
    text: `${prospect.preview.outreachBody}\n\nCampaign Preview: ${previewUrl}\n\nIf this is not relevant, opt out here: ${unsubscribeUrl}`,
    idempotencyKey: `adforge-prospect-${prospect.id}`,
    headers: {
      'List-Unsubscribe': `<${oneClickUnsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
}
