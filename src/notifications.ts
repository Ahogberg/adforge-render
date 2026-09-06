import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Handlebars from 'handlebars';
import { config } from './config.js';
import type { Project } from './types.js';

export async function sendApplicationEmails(project: Project): Promise<{ confirmation: boolean; operator: boolean }> {
  if (!config.resendKey || !config.intakeFrom) return { confirmation: false, operator: false };
  const source = await readFile(path.join(config.templateDir, 'application-confirmation.hbs'), 'utf8');
  const template = Handlebars.compile(source);
  const firstName = project.intake.contactName.split(/\s+/)[0] || project.intake.contactName;
  const sampleUrl = `${config.marketingUrl.replace(/\/$/, '')}/sample`;
  const html = template({
    firstName,
    company: project.intake.companyName,
    sourceType: project.intake.sourceType,
    reference: project.id.slice(0, 8),
    sampleUrl,
    marketingUrl: config.marketingUrl,
    replyEmail: config.intakeReplyTo || 'hello@adforgecreative.com',
  });

  await send({
    to: project.intake.contactEmail,
    subject: 'We have your Afterword application',
    html,
    idempotencyKey: `afterword-intake-confirmation-${project.id}`,
  });

  if (config.intakeNotifyTo) {
    await send({
      to: config.intakeNotifyTo,
      subject: `New Afterword application · ${project.intake.companyName}`,
      text: [
        `Reference: ${project.id}`,
        `Contact: ${project.intake.contactName} <${project.intake.contactEmail}>`,
        `Company: ${project.intake.companyName}`,
        `Website: ${project.intake.website}`,
        `Source: ${project.intake.sourceUrl || project.intake.sourceType}`,
        `Audience: ${project.intake.audience}`,
        `Offer: ${project.intake.offer}`,
        `CTA: ${project.intake.callToAction}`,
      ].join('\n'),
      idempotencyKey: `afterword-intake-operator-${project.id}`,
    });
  }
  return { confirmation: true, operator: Boolean(config.intakeNotifyTo) };
}

async function send(input: { to: string; subject: string; idempotencyKey: string; html?: string; text?: string }): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
    body: JSON.stringify({ from: config.intakeFrom, to: [input.to], reply_to: config.intakeReplyTo || undefined, subject: input.subject, html: input.html, text: input.text }),
  });
  const payload = await response.json() as { id?: string; message?: string };
  if (!response.ok || !payload.id) throw new Error(payload.message || `Email provider rejected the request (${response.status})`);
}
