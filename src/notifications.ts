import { config } from './config.js';
import { sendMail, type MailMessage } from './mail.js';
import type { ProjectStore } from './store.js';
import type { Project } from './types.js';

/**
 * Transactional email for the production flow. Every send is recorded on the
 * project timeline and never throws, so a mail outage cannot stall production.
 */
export class ProjectNotifier {
  constructor(private readonly store: ProjectStore) {}

  /** A new application arrived: confirm to the client, alert the operator. */
  async intakeReceived(project: Project): Promise<void> {
    const needsSource = project.status === 'awaiting-source';
    await this.toClient(project, {
      subject: `We received your AdForge application, ${firstName(project)}`,
      text: [
        `Hi ${firstName(project)},`,
        '',
        `Thanks for applying on behalf of ${project.intake.companyName}. Your application is in our queue.`,
        '',
        'What happens next:',
        '1. Within 24 hours we reply by email with the campaign angle we would develop and a clear fit decision.',
        '2. If it fits, that reply includes the payment step. No payment has been taken.',
        '3. Production starts as soon as intake is complete, and the first delivery lands within 48 hours.',
        '',
        project.intake.sourceUrl
          ? `Source we will work from: ${project.intake.sourceUrl}`
          : 'If you have a recording or transcript ready, simply reply to this email with the file or link.',
        '',
        'Reply to this email at any time if anything changes.',
        '',
        'AdForge',
      ].join('\n'),
    }, 'client-intake');
    await this.toOperator(project, {
      subject: `New application: ${project.intake.companyName}${needsSource ? ' (source needed)' : ''}`,
      text: [
        `${project.intake.contactName} <${project.intake.contactEmail}> applied for ${project.intake.companyName}.`,
        '',
        `Website: ${project.intake.website}`,
        `Source (${project.intake.sourceType}): ${project.intake.sourceUrl || 'none supplied'}`,
        `Audience: ${project.intake.audience}`,
        `Offer: ${project.intake.offer}`,
        `CTA: ${project.intake.callToAction}`,
        project.intake.toneNotes ? `Tone notes: ${project.intake.toneNotes}` : '',
        '',
        needsSource
          ? 'No transcript or recording was attached. The engine is trying to capture the source from the URL; if that fails, add it from the dashboard to start production.'
          : 'Production has started automatically.',
        '',
        `Dashboard: ${config.publicUrl}/`,
        `Project: ${project.id}`,
      ].filter((line) => line !== undefined).join('\n'),
    }, 'operator-intake');
  }

  /** The quality gate passed and artifacts exist. */
  async campaignReady(project: Project): Promise<void> {
    const revised = Boolean(project.revisionNote);
    await this.toOperator(project, {
      subject: `${revised ? 'Revised campaign' : 'Campaign'} ready for your check: ${project.intake.companyName}`,
      text: [
        `${project.bundle?.title ?? 'The campaign'} passed the quality gate with a score of ${project.quality?.score ?? '?'}/100.`,
        '',
        `Review page: ${reviewUrl(project)}`,
        `Dashboard: ${config.publicUrl}/`,
        '',
        config.autoDeliver
          ? 'The client has been sent the review link automatically (ADFORGE_AUTO_DELIVER is on).'
          : 'Open the review page, check the work, then press "Send to client" in the dashboard to release it.',
      ].join('\n'),
    }, 'operator-ready');
    if (config.autoDeliver) await this.deliverToClient(project);
  }

  /** Emails the private review link to the client and stamps the project. */
  async deliverToClient(project: Project): Promise<Project> {
    const revised = Boolean(project.revisionNote);
    const sent = await this.toClient(project, {
      subject: `${revised ? 'Your revised campaign' : 'Your campaign'} is ready for review, ${firstName(project)}`,
      text: [
        `Hi ${firstName(project)},`,
        '',
        `${revised ? 'The revised campaign' : 'Your first AdForge campaign'} for ${project.intake.companyName} is ready.`,
        '',
        `Review it here: ${reviewUrl(project)}`,
        '',
        'The page shows the full guide and the quality checks. You can approve the campaign with one click, or collect every requested change into one consolidated revision note.',
        '',
        'Reply to this email if you would rather talk anything through.',
        '',
        'AdForge',
      ].join('\n'),
    }, 'client-review');
    if (!sent) return (await this.store.get(project.id)) ?? project;
    return this.store.update(project.id, { deliveredAt: new Date().toISOString() }, { type: 'email', message: 'Review link sent to the client' });
  }

  async clientDecision(project: Project, decision: 'approve' | 'revise', note = ''): Promise<void> {
    await this.toOperator(project, {
      subject: decision === 'approve'
        ? `Approved: ${project.intake.companyName}`
        : `Revision requested: ${project.intake.companyName}`,
      text: [
        decision === 'approve'
          ? `${project.intake.contactName} approved the campaign. The delivery is locked and the ZIP is ready in the dashboard.`
          : `${project.intake.contactName} requested one consolidated revision. Production has re-entered the queue automatically.`,
        '',
        note ? `Revision note:\n${note}\n` : '',
        `Dashboard: ${config.publicUrl}/`,
        `Review page: ${reviewUrl(project)}`,
      ].join('\n'),
    }, `operator-${decision}`);
  }

  async productionFailed(project: Project, reason: string): Promise<void> {
    await this.toOperator(project, {
      subject: `Production failed: ${project.intake.companyName}`,
      text: [
        `The pipeline stopped for ${project.intake.companyName}.`,
        '',
        `Reason: ${reason}`,
        '',
        `Fix the input or re-run from the dashboard: ${config.publicUrl}/`,
      ].join('\n'),
    }, 'operator-failed');
  }

  private async toClient(project: Project, message: Omit<MailMessage, 'to'>, kind: string): Promise<boolean> {
    return this.deliver(project, { ...message, to: project.intake.contactEmail }, kind);
  }

  private async toOperator(project: Project, message: Omit<MailMessage, 'to'>, kind: string): Promise<boolean> {
    if (!config.operatorEmail) {
      await this.record(project.id, `Operator email skipped (${kind}): set ADFORGE_OPERATOR_EMAIL to receive notifications`);
      return false;
    }
    return this.deliver(project, { ...message, to: config.operatorEmail, replyTo: project.intake.contactEmail }, kind);
  }

  private async deliver(project: Project, message: MailMessage, kind: string): Promise<boolean> {
    try {
      const result = await sendMail(message);
      await this.record(project.id, result.dryRun
        ? `Email dry run (${kind}) to ${message.to}: "${message.subject}"`
        : `Email sent (${kind}) to ${message.to}: "${message.subject}"`);
      return !result.dryRun;
    } catch (error) {
      await this.record(project.id, `Email failed (${kind}) to ${message.to}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async record(projectId: string, message: string): Promise<void> {
    try { await this.store.update(projectId, {}, { type: 'email', message }); }
    catch (error) { console.error('Could not record email event', error); }
  }
}

function reviewUrl(project: Project): string {
  return `${config.publicUrl}/review/${project.reviewToken}`;
}

function firstName(project: Project): string {
  return project.intake.contactName.trim().split(/\s+/)[0] || 'there';
}
