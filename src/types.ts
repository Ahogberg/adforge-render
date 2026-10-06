import { z } from 'zod';

export const projectStatusSchema = z.enum([
  'intake',
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
  referral: z.string().trim().max(100).optional().default(''),
  expertName: z.string().trim().max(120).optional().default(''),
  voiceExamples: z.string().trim().max(15_000).optional().default(''),
});

export const sourceReferenceSchema = z.object({
  claim: z.string(),
  quote: z.string(),
  speaker: z.string(),
  timestamp: z.string(),
});

export const SECTION_LAYOUTS = ['essay', 'framework', 'stat', 'comparison'] as const;

export const frameworkSchema = z.object({
  name: z.string(),
  kind: z.enum(['sequence', 'pillars']),
  items: z.array(z.object({ label: z.string(), detail: z.string() })).min(2).max(6),
});

export const statSchema = z.object({
  /** The figure exactly as the speaker said it, e.g. "31 of 40" or "40%". Verified against the transcript. */
  value: z.string(),
  label: z.string(),
  context: z.string(),
  sourceTimestamp: z.string(),
});

export const comparisonSchema = z.object({
  leftLabel: z.string(),
  rightLabel: z.string(),
  rows: z.array(z.object({ left: z.string(), right: z.string() })).min(2).max(6),
});

export const sectionSchema = z.object({
  eyebrow: z.string(),
  title: z.string(),
  body: z.array(z.string()),
  pullQuote: z.string().nullable().optional().transform((value) => value ?? undefined),
  sourceTimestamp: z.string().nullable().optional().transform((value) => value ?? undefined),
  /** Page layout for the section; undefined means a plain essay page. */
  layout: z.enum(SECTION_LAYOUTS).nullable().optional().transform((value) => value ?? undefined),
  framework: frameworkSchema.nullable().optional().transform((value) => value ?? undefined),
  stat: statSchema.nullable().optional().transform((value) => value ?? undefined),
  comparison: comparisonSchema.nullable().optional().transform((value) => value ?? undefined),
}).transform((section) => ({ ...section, layout: effectiveLayout(section) }));

/** A layout without its feature block falls back to a plain essay page. */
export function effectiveLayout(section: { layout?: SectionLayout | null; framework?: unknown; stat?: unknown; comparison?: unknown }): SectionLayout {
  if (section.layout === 'framework' && section.framework) return 'framework';
  if (section.layout === 'stat' && section.stat) return 'stat';
  if (section.layout === 'comparison' && section.comparison) return 'comparison';
  return 'essay';
}

export const carouselSchema = z.object({
  title: z.string(),
  slides: z.array(z.object({ heading: z.string(), body: z.string() })).min(3).max(8),
  closing: z.string(),
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
  /** LinkedIn document carousel derived from the guide. Older campaigns have none. */
  carousel: carouselSchema.nullable().optional().transform((value) => value ?? undefined),
});

export const qualityReportSchema = z.object({
  score: z.number().min(0).max(100),
  checks: z.array(z.object({ name: z.string(), status: z.enum(['pass', 'warning', 'fail']), detail: z.string() })),
  blockers: z.array(z.string()),
});

export type ProjectStatus = z.infer<typeof projectStatusSchema>;
export type Intake = z.infer<typeof intakeSchema>;
export type SectionLayout = (typeof SECTION_LAYOUTS)[number];
export type Framework = z.infer<typeof frameworkSchema>;
export type Stat = z.infer<typeof statSchema>;
export type Comparison = z.infer<typeof comparisonSchema>;
export type Carousel = z.infer<typeof carouselSchema>;

/** Sections written before layouts existed have no layout fields; all of them are optional. */
export interface CampaignSection {
  eyebrow: string;
  title: string;
  body: string[];
  pullQuote?: string;
  sourceTimestamp?: string;
  layout?: SectionLayout;
  framework?: Framework;
  stat?: Stat;
  comparison?: Comparison;
}

export type CampaignBundle = Omit<z.infer<typeof campaignBundleSchema>, 'sections' | 'carousel'> & {
  sections: CampaignSection[];
  carousel?: Carousel;
};
export type QualityReport = z.infer<typeof qualityReportSchema>;

export interface BrandProfile {
  title: string;
  description: string;
  logoUrl: string;
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  /** Computed font-family of the website's main heading; used to match the display face. */
  headingFontFamily?: string;
  borderRadius: string;
  voiceSample: string;
  sourceUrl: string;
}

export interface VideoArtifact {
  file: string;
  poster: string;
  title: string;
  kind: 'stat' | 'quote' | 'speaker' | 'audiogram';
  durationSeconds: number;
  /** Source window for speaker clips, in seconds. */
  sourceStart?: number;
  sourceEnd?: number;
}

export interface ProjectArtifacts {
  pdf: string;
  landingPage: string;
  deliveryZip: string;
  carouselPdf?: string;
  carouselSlides?: string[];
  postCards?: string[];
  motionClips?: VideoArtifact[];
  speakerClips?: VideoArtifact[];
  /** Typography and palette decisions, for the operator. */
  designSummary?: string;
  /** Non-blocking render problems the operator should know about. */
  notes?: string[];
}

export interface ProjectEvent {
  id: string;
  at: string;
  type: 'status' | 'note' | 'approval' | 'error';
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
  reviewToken: string;
  brand?: BrandProfile;
  bundle?: CampaignBundle;
  quality?: QualityReport;
  artifacts?: ProjectArtifacts;
  events: ProjectEvent[];
  revisionNote?: string;
  revisionCount?: number;
  prospectId?: string;
  clientId?: string;
  approvedAt?: string;
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
  previewViews?: number;
  previewFirstViewedAt?: string;
  appliedProjectId?: string;
  error?: string;
  events: ProspectEvent[];
}

export const clientMemorySchema = z.object({
  /** Preferred wording, e.g. "Say 'client', never 'customer'". */
  terminology: z.array(z.string().trim().min(2).max(300)).max(60).default([]),
  /** Phrases that must never appear in any asset. */
  bannedPhrases: z.array(z.string().trim().min(2).max(120)).max(60).default([]),
  /** The expert's own writing, used as the voice reference. */
  voiceExamples: z.array(z.string().trim().min(20).max(3_000)).max(8).default([]),
  /** Durable editorial preferences distilled from reviews. */
  styleNotes: z.array(z.string().trim().min(2).max(400)).max(40).default([]),
});

export type ClientMemory = z.infer<typeof clientMemorySchema>;

export interface ClientCampaignRecord {
  projectId: string;
  approvedAt: string;
  campaignAngle: string;
  title: string;
  hooks: string[];
}

export interface ClientCorrection {
  projectId: string;
  at: string;
  note: string;
}

export interface Client {
  id: string;
  /** Normalized website hostname; one client per company domain. */
  domain: string;
  companyName: string;
  expertName: string;
  memory: ClientMemory;
  campaigns: ClientCampaignRecord[];
  corrections: ClientCorrection[];
  createdAt: string;
  updatedAt: string;
}
