import { describe, expect, it } from 'vitest';
import { generateProspectPreview } from '../src/ai.js';
import { sendProspectEmail } from '../src/outreach.js';
import { renderProspectPreview } from '../src/prospect-preview.js';
import { prospectInputSchema, type BrandProfile, type Prospect } from '../src/types.js';

const input = prospectInputSchema.parse({
  companyName: 'Signal Partners',
  website: 'https://example.com',
  contactName: 'Avery Stone',
  contactEmail: 'avery@example.com',
  role: 'Managing Partner',
  country: 'United Kingdom',
  sourceUrl: 'https://example.com/webinar',
  sourceTitle: 'How Expert Firms Build Trust',
  sourceSummary: 'Expert firms build trust when their useful internal knowledge becomes clear enough for a buyer to apply before a sales conversation.',
  offerHint: 'Growth advisory for specialist consulting firms',
});

const brand: BrandProfile = {
  title: 'Signal Partners', description: input.offerHint, logoUrl: '', primaryColor: '#C99B42',
  backgroundColor: '#ffffff', textColor: '#111111', fontFamily: 'Arial', borderRadius: '4px',
  voiceSample: 'Clear and direct advice for specialist firms.', sourceUrl: input.website,
};

describe('prospect generation', () => {
  it('creates a complete meeting-free Campaign Preview in demo mode', async () => {
    const result = await generateProspectPreview(input, brand);
    expect(result.qualification.score).toBeGreaterThanOrEqual(70);
    expect(result.preview.articleAngles).toHaveLength(3);
    expect(result.preview.linkedinHooks).toHaveLength(3);
    expect(result.preview.outreachBody).not.toMatch(/book a (call|meeting)/i);
  });

  it('renders a private preview and blocks live email without operator approval', async () => {
    const generated = await generateProspectPreview(input, brand);
    const prospect: Prospect = {
      id: 'prospect-1', previewToken: 'private-token', input, status: 'preview-ready',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mode: 'demo',
      brand, ...generated, events: [],
    };
    const html = renderProspectPreview(prospect);
    expect(html).toContain('Private Campaign Preview');
    expect(html).toContain('Thirteen finished assets');
    await expect(sendProspectEmail(prospect)).rejects.toThrow('Operator approval');
  });

  it('validates an approved outreach as a dry run without provider credentials', async () => {
    const generated = await generateProspectPreview(input, brand);
    const prospect: Prospect = {
      id: 'prospect-2', previewToken: 'private-token-2', input, status: 'approved',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mode: 'demo',
      brand, ...generated, approvedAt: new Date().toISOString(), events: [],
    };
    await expect(sendProspectEmail(prospect)).resolves.toEqual({ dryRun: true });
  });
});
