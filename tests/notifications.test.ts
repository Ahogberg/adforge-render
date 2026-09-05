import { describe, expect, it } from 'vitest';
import { isMailLive, sendMail } from '../src/mail.js';
import { ProjectNotifier } from '../src/notifications.js';
import { ProjectStore } from '../src/store.js';
import { hasSource } from '../src/source.js';
import { intakeSchema } from '../src/types.js';

const intake = intakeSchema.parse({
  companyName: 'Signal Partners', contactName: 'Avery Stone', contactEmail: 'avery@example.com',
  website: 'https://example.com', sourceType: 'podcast', sourceUrl: 'https://example.com/episode',
  audience: 'Founders of specialist consultancies', offer: 'Growth advisory', callToAction: 'Book a review',
});

describe('transactional email', () => {
  it('is a dry run without provider credentials', async () => {
    expect(isMailLive()).toBe(false);
    await expect(sendMail({ to: 'someone@example.com', subject: 'Test', text: 'Body' })).resolves.toEqual({ dryRun: true });
  });

  it('records every notification on the project timeline and never throws', async () => {
    const store = new ProjectStore();
    await store.initialize();
    const notifier = new ProjectNotifier(store);
    let project = await store.create(intake, 'demo');

    await notifier.intakeReceived(project);
    await notifier.clientDecision(project, 'revise', 'Tighten the introduction');
    await notifier.productionFailed(project, 'Quality gate failed');
    project = await notifier.deliverToClient(project);

    expect(project.deliveredAt).toBeUndefined();
    const messages = project.events.filter((event) => event.type === 'email').map((event) => event.message);
    expect(messages).toHaveLength(5);
    expect(messages.filter((message) => message.startsWith('Email dry run'))).toHaveLength(2);
    expect(messages.filter((message) => message.includes('Operator email skipped'))).toHaveLength(3);
  });

  it('knows when production can start', () => {
    expect(hasSource({ transcript: '', sourceFile: undefined })).toBe(false);
    expect(hasSource({ transcript: '   ', sourceFile: undefined })).toBe(false);
    expect(hasSource({ transcript: 'Words', sourceFile: undefined })).toBe(true);
    expect(hasSource({ transcript: '', sourceFile: '/tmp/source.mp3' })).toBe(true);
  });
});
