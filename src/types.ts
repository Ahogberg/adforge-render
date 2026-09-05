import { z } from 'zod';

export const projectStatusSchema = z.enum([
  'intake',
  'awaiting-source',
  'queued',
  'transcribing',
  'extracting',
  'writing',
  'quality-check',
  'rendering',
  'client-review',
  'revision',
  'approved',
  'failed',
]);

export const intakeSchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  contactName: z.string().trim().min(2).max(120),
  contactEmail: z.string().trim().email().max(200),
  website: z.string().trim().url().max(500),
  sourceType: z.enum(['webinar', 'podcast', 'workshop', 'keynote', 'interview', 'presentation']),
  sourceUrl: z.string().trim().url().max(1000).optional().or(z.literal('')),
  transcript: z.string().trim().max(250_000).optional().default(''),
  audience: z.string().trim().min(3).max(500),
  offer: z.string().trim().min(3).max(500),
  callToAction: z.string().trim().min(3).max(500),
  toneNotes: z.string().trim().max(1500).optional().default(''),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().default('#E8C97A'),
});

export const sourceReferenceSchema = z.object({
  claim: z.string(),
  quote: z.string(),
  speaker: z.string(),
  timestamp: z.string(),
});

export const sectionSchema = z.object({
  eyebrow: z.string(),
  title: z.string(),
  body: z.array(z.string()),
  pullQuote: z.string().nullable().optional().transform((value) => value ?? undefined),
  sourceTimestamp: z.string().nullable().optional().transform((value) => value ?? undefined),
});

export const campaignBundleSchema = z.object({
  campaignAngle: z.string(),
  title: z.string(),
  subtitle: z.string(),
  executiveSummary: z.string(),
  sections: z.array(sectionSchema).min(4).max(10),
  actionChecklist: z.array(z.string()).min(4).max(8),
  linkedinPosts: z.array(z.object({ hook: z.string(), body: z.string(), cta: z.string() })).length(8),
  emails: z.array(z.object({ subject: z.string(), preview: z.string(), body: z.string(), cta: z.string() })).length(3),
  landingPage: z.object({
    eyebrow: z.string(),
    headline: z.string(),
    subheadline: z.string(),
    bullets: z.array(z.string()).min(3).max(5),
    formHeading: z.string(),
    buttonLabel: z.string(),
  }),
  sourceReferences: z.array(sourceReferenceSchema).max(20),
});

export const qualityReportSchema = z.object({
  score: z.number().min(0).max(100),
  checks: z.array(z.object({ name: z.string(), status: z.enum(['pass', 'warning', 'fail']), detail: z.string() })),
  blockers: z.array(z.string()),
});

export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type Intake = z.infer<typeof intakeSchema>;
export type CampaignBundle = z.infer<typeof campaignBundleSchema>;
export type QualityReport = z.infer<typeof qualityReportSchema>;

export interface BrandProfile {
  title: string;
  description: string;
  logoUrl: string;
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  borderRadius: string;
  voiceSample: string;
  sourceUrl: string;
}

export interface ProjectEvent {
  id: string;
  at: string;
  type: 'status' | 'note' | 'approval' | 'email' | 'error';
  message: string;
}

export interface Project {
  id: string;
  intake: Intake;
  status: ProjectStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  transcript: string;
  sourceFile?: string;
  /** Text captured automatically from the public source URL, waiting for operator confirmation. */
  sourceCandidate?: string;
  reviewToken: string;
  brand?: BrandProfile;
  bundle?: CampaignBundle;
  quality?: QualityReport;
  artifacts?: {
    pdf: string;
    landingPage: string;
    deliveryZip: string;
  };
  events: ProjectEvent[];
  revisionNote?: string;
  /** Set when the review link has been emailed to the client. */
  deliveredAt?: string;
  error?: string;
  mode: 'live' | 'demo';
}

export const prospectStatusSchema = z.enum([
  'imported',
  'queued',
  'researching',
  'preview-ready',
  'approved',
  'sent',
  'replied',
  'qualified',
  'won',
  'lost',
  'unsubscribed',
  'failed',
]);

export const prospectInputSchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  website: z.string().trim().url().max(500),
  contactName: z.string().trim().max(120).optional().default(''),
  contactEmail: z.string().trim().email().max(200).optional().or(z.literal('')).default(''),
  role: z.string().trim().max(120).optional().default(''),
  country: z.string().trim().max(80).optional().default(''),
  sourceUrl: z.string().trim().url().max(1000),
  sourceTitle: z.string().trim().min(3).max(300),
  sourceSummary: z.string().trim().min(20).max(12_000),
  offerHint: z.string().trim().max(500).optional().default(''),
  notes: z.string().trim().max(2000).optional().default(''),
});

export const prospectQualificationSchema = z.object({
  score: z.number().int().min(0).max(100),
  tier: z.enum(['A', 'B', 'C', 'reject']),
  fitReasons: z.array(z.string()).min(2).max(5),
  risks: z.array(z.string()).max(4),
  likelyAudience: z.string(),
  likelyOffer: z.string(),
  sourceSignal: z.string(),
  personalizationAngle: z.string(),
});

export const prospectPreviewSchema = z.object({
  campaignAngle: z.string(),
  guideTitle: z.string(),
  guideSubtitle: z.string(),
  whyNow: z.string(),
  sourceMoment: z.string(),
  articleAngles: z.array(z.string()).length(3),
  linkedinHooks: z.array(z.string()).length(3),
  outreachSubject: z.string(),
  outreachBody: z.string(),
});

export type ProspectStatus = z.infer<typeof prospectStatusSchema>;
export type ProspectInput = z.infer<typeof prospectInputSchema>;
export type ProspectQualification = z.infer<typeof prospectQualificationSchema>;
export type ProspectPreview = z.infer<typeof prospectPreviewSchema>;

export interface ProspectEvent {
  id: string;
  at: string;
  type: 'status' | 'note' | 'email' | 'conversion' | 'error';
  message: string;
}

export interface Prospect {
  id: string;
  previewToken: string;
  input: ProspectInput;
  status: ProspectStatus;
  createdAt: string;
  updatedAt: string;
  mode: 'live' | 'demo';
  qualification?: ProspectQualification;
  preview?: ProspectPreview;
  brand?: BrandProfile;
  approvedAt?: string;
  sentAt?: string;
  providerMessageId?: string;
  replyNote?: string;
  conversionValue?: number;
  error?: string;
  events: ProspectEvent[];
}
