/**
 * Renders the public sales sample: the first live campaign (fictional Northstar Advisory webinar),
 * re-branded as the fictional client and rendered with the current engine.
 *
 *   npx tsx scripts/sample-campaign.ts <output-dir>
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { renderArtifacts } from '../src/render.js';
import { intakeSchema, type BrandProfile, type CampaignBundle, type Project } from '../src/types.js';

const out = path.resolve(process.argv[2] ?? 'sample-out');

const intake = intakeSchema.parse({
  companyName: 'Northstar Advisory', contactName: 'Maya Chen', contactEmail: 'maya@northstaradvisory.example',
  website: 'https://northstaradvisory.example', sourceType: 'webinar', expertName: 'Maya Chen, Managing Partner',
  audience: 'Managing partners at professional-services firms planning a rate change',
  offer: 'Pricing advisory for professional-services firms', callToAction: 'Book a 30-minute pricing review',
});

const brand: BrandProfile = {
  title: 'Northstar Advisory', description: 'Pricing advisory for professional-services firms', logoUrl: '',
  primaryColor: '#B5772F', backgroundColor: '#F6F3EC', textColor: '#18202C',
  fontFamily: '"IBM Plex Sans", sans-serif', headingFontFamily: 'Newsreader, serif',
  borderRadius: '2px', voiceSample: '', sourceUrl: 'https://northstaradvisory.example',
};

const q = (text: string) => text;
const bundle: CampaignBundle = {
  campaignAngle: 'The handover between partner approval and the client invoice determines whether a new rate holds.',
  title: 'The rate the partners approved is not necessarily the rate clients pay',
  subtitle: 'Prepare the client conversation, set the boundary for the first no, and check the invoices.',
  executiveSummary: 'Partner approval does not tell me what clients will pay. Before announcing a new rate, I would give account leads an explanation they can use, decide what the first refusal may change, and schedule an account-by-account invoice review.',
  sections: [
    {
      eyebrow: 'The gap', title: 'Approval does not mean the new rate held', layout: 'stat',
      body: [
        'Last year, we reviewed 40 pricing changes at services firms. Partners unanimously approved 31 of them, yet 19 of those 31 had quietly reverted within 90 days. These are observations from our review, not an industry benchmark.',
        'Approval settles a decision inside the firm. It does not settle what an account lead says when a client asks for the old rate, or what appears on the invoice. After the partner meeting, I would ask who is responsible for carrying the decision through.',
      ],
      stat: { value: '19 of those 31', label: 'Unanimously approved changes that quietly reverted', context: 'From our review of 40 pricing changes at services firms last year.', sourceTimestamp: '00:45' },
    },
    {
      eyebrow: 'The handover', title: 'A number and a date are not enough', layout: 'essay',
      body: [
        'I often see the account lead receive the new number and its start date, then become responsible for explaining both to a client. A slide records the decision. It rarely gives someone words they can use in a conversation.',
        'I would put the writing with the partner who argued for the change. That partner should turn the firm\'s reasoning into an explanation of what changed for the client. Otherwise, each account lead is left to make that translation alone.',
        'Before the announcement, ask whether account leads can explain the change aloud. Distributing the new rate is not the same as preparing them to discuss it.',
      ],
      pullQuote: q('The spreadsheet was never the problem. The handover was.'), sourceTimestamp: '01:09',
    },
    {
      eyebrow: 'The preparation', title: 'Write the client sentence', layout: 'framework',
      body: [
        'I ask partners to prepare one sentence explaining what changed and why it is worth it to the client, then one paragraph for the first objection. These should be working words, not a script.',
        'Ask the account lead to say both aloud. If the wording sounds like an internal memo, rewrite it before the client call.',
      ],
      framework: { name: 'Prepare the client explanation', kind: 'sequence', items: [
        { label: 'Explain the change', detail: 'Write one sentence on what changed and why it is worth it to the client.' },
        { label: 'Prepare the objection', detail: 'Write one paragraph for the first objection the account lead expects.' },
        { label: 'Say it aloud', detail: 'Have the account lead speak both parts. Rewrite anything that sounds like a memo.' },
      ] },
      pullQuote: q('We ask partners to write what we call the client sentence. One sentence that explains what changed and why it is worth it to the client, not to us. Then one paragraph for the first objection.'), sourceTimestamp: '02:34',
    },
    {
      eyebrow: 'The first objection', title: 'Hear what the old‑rate question is testing', layout: 'essay',
      body: [
        'A client may say they have always paid the old rate. I would not treat that as an automatic reason to concede. It can test whether the person presenting the new rate believes it will hold.',
        'Prepare for that question explicitly. The account lead should be able to acknowledge it, explain the change and continue the conversation without revising the rate on the spot. Practise before the call, not while the client is waiting for an answer.',
      ],
      pullQuote: q('"We\'ve always paid the old rate." Which isn\'t really an objection, it\'s a test. The client wants to know if you believe the new number. If the account lead hesitates, the client has their answer.'), sourceTimestamp: '02:55',
    },
    {
      eyebrow: 'The boundary', title: 'Decide what the first no may change', layout: 'comparison',
      body: [
        'The first refusal is the wrong moment to decide which parts of the offer are negotiable. Without an agreed boundary, the account lead must make that decision while the client is waiting.',
        'I would settle the boundary before announcing the change. Scope or payment terms may flex; the rate does not move in the first conversation. Write down that distinction for everyone who will speak with clients.',
      ],
      comparison: { leftLabel: 'Decide during the call', rightLabel: 'Set the boundary beforehand', rows: [
        { left: 'The account lead judges each refusal alone.', right: 'The account lead knows what the first no may change.' },
        { left: 'Scope and payment terms have no agreed position.', right: 'Scope or payment terms may flex.' },
        { left: 'The rate may move in the first conversation.', right: 'The rate stays in place during that conversation.' },
      ] },
      pullQuote: q('Before you announce anything, decide what a first no may change and what it may not. Maybe the scope can flex, maybe the payment terms can flex. But the rate does not move on the first conversation.'), sourceTimestamp: '03:17',
    },
    {
      eyebrow: 'The check', title: 'Put the invoice review in the calendar now', layout: 'stat',
      body: [
        'An agreement records the intended rate. It does not show what the client was invoiced. I would schedule an account-by-account invoice review for ninety days after the change. For most of our clients, that is roughly one renewal cycle; it is also where we saw reversions cluster.',
        'Set the date and name the owners before the announcement. At the review, compare each account\'s intended new rate with what was invoiced. That is where I would look for quiet reversions.',
      ],
      stat: { value: 'Ninety days', label: 'After the change, review invoices account by account', context: 'Check what was actually invoiced, not what was agreed.', sourceTimestamp: '03:44' },
      pullQuote: q('Ninety days after the change, sit down and look at what was actually invoiced, account by account. Not what was agreed. What was invoiced. That\'s where you find the quiet reversions.'), sourceTimestamp: '03:44',
    },
  ],
  actionChecklist: [
    'Ask the partner who argued for the change to write the client sentence and a paragraph for the first objection.',
    'Have account leads say both aloud before client calls.',
    'Agree before announcing what the first no may change. Scope or payment terms may flex; the rate does not move in the first conversation.',
    'Put a ninety-day, account-by-account invoice review in the calendar with named owners.',
    'Compare what was invoiced with the intended new rate. If you are planning a change, book a 30-minute pricing review with Northstar Advisory to examine the preparation.',
  ],
  linkedinPosts: [
    { hook: 'Last year, we reviewed 40 pricing changes at services firms.', body: 'Partners unanimously approved 31 of them. Yet 19 of those 31 had quietly reverted within 90 days. These are observations from our review, not an industry benchmark.\n\nA partner vote settles an internal decision. It does not tell me what an account lead will say when a client asks for the old rate, or what that client will be invoiced.\n\nI would make the handover part of the rate decision: prepare the explanation, set the boundary for the first refusal and assign an owner to check the invoices.', cta: 'Get the guide if you are preparing a rate change.' },
    { hook: 'If I argue for a new rate, I should write the client explanation.', body: 'I would not hand account leads a number and a start date, then expect them to make the case themselves.\n\nThe partner who argued for the change should put the reasoning into words an account lead can say to a client. A slide can record the decision. It cannot show whether the person presenting it is ready for the conversation.\n\nBefore the announcement, I would ask an account lead to say the explanation aloud. If it does not work when spoken, the handover is not finished.', cta: 'Get the guide to prepare the handover.' },
    { hook: 'I ask an account lead to say the rate explanation aloud before the first client call.', body: 'That test catches wording that reads well on a page but sounds like an internal memo.\n\nI ask the partner to write one sentence on what changed and why it is worth it to the client, followed by a paragraph for the first objection. The account lead should be able to use both in conversation, not recite them as a script.\n\nIf the words are difficult to say, I would revise them before the call.', cta: 'Get the guide for the preparation test.' },
    { hook: 'The client sentence must answer a client question.', body: 'I ask what changed and why it is worth it to the client. An account lead who can only explain the firm\'s internal reasons still needs a client explanation.\n\nI would ask the partner who argued for the rate to write one sentence, then have an account lead say it aloud. Where do they stumble? Which words need an internal memo to explain them?\n\nRevise the sentence until it describes the actual change in terms the client can assess. Do not promise value you cannot substantiate.', cta: 'Get the guide for the client sentence and the first-objection preparation.' },
    { hook: 'A client asks to keep paying the old rate.', body: 'I would prepare for that question before the call. It is not, by itself, a reason to revise the new rate.\n\nThe question may test whether the account lead believes the new rate will hold. I want that person ready to acknowledge the client\'s history, explain the change and continue the discussion without changing the number on the spot.\n\nThat takes practice with the first objection, as well as an agreed boundary for what may change.', cta: 'Get the guide to prepare for the old-rate question.' },
    { hook: 'I decide what a first no may change before a client says it.', body: 'An account lead should not have to settle the firm\'s position during a difficult call.\n\nBefore announcing a rate change, I would agree the boundary with everyone who will speak to clients. Scope or payment terms may flex. The rate does not move in the first conversation.\n\nI would write that down alongside the client explanation and ask account leads whether they know what they can discuss and what needs a further decision.', cta: 'Get the guide for the first-no boundary.' },
    { hook: 'An agreement can show the new rate while an invoice shows something else.', body: 'That is why I would not end a rate-change review by asking whether clients agreed to the new terms. I would ask what each account was actually invoiced.\n\nSchedule an account-by-account check for 90 days after the change. For most of our clients, that is roughly one renewal cycle; it is also where we saw reversions cluster.\n\nCompare the intended new rate with the invoices. The agreement records what was decided. The invoice shows what was charged.', cta: 'Get the guide for the invoice check.' },
    { hook: 'I put names against the invoice review before announcing a rate change.', body: 'If I leave ownership until later, the check is easy to postpone after the announcement and client calls.\n\nI would schedule the account-by-account review now. Name who will bring the intended rates, who will bring the invoices and who will follow up when they do not match.\n\nThe review tests whether the client explanation and the agreed boundary carried through to what clients were charged. A calendar entry alone does not do that work.', cta: 'Get the guide to plan the review.' },
  ],
  emails: [
    { subject: 'Your guide to carrying a new rate through', preview: 'From partner approval to the client invoice.', body: 'Here is the guide: The rate the partners approved is not necessarily the rate clients pay.\n\nAfter partners approve a change, I ask how the rate will make it through the client conversation and onto the invoice.\n\nThe guide covers the preparation I would make before announcing it: give account leads an explanation they can say aloud, decide what the first refusal may change and schedule an account-by-account invoice review with named owners.', cta: 'Download the guide' },
    { subject: 'Decide what the first no may change', preview: 'Set the boundary before the client call.', body: 'When a client asks for the old rate, I do not want the account lead deciding the firm\'s position for the first time.\n\nBefore the announcement, I would agree what can move. Scope or payment terms may flex. The rate does not move in that first conversation.\n\nWrite that boundary beside the client explanation, then practise the first objection aloud. The boundary is useful only if the person on the call can apply it.', cta: 'Read the section on the first no' },
    { subject: 'Planning a rate change?', preview: 'Bring your client explanation, first-no boundary and invoice plan.', body: 'Before announcing a rate change, I would ask three questions.\n\nCan an account lead explain what changed and why it is worth it to the client? Have you agreed what the first no may change? Who will compare the intended new rate with what was actually invoiced, account by account, 90 days later?\n\nBook a 30-minute pricing review with Northstar Advisory. We can examine your client explanation, first-no boundary and invoice-review plan.', cta: 'Book a 30-minute pricing review' },
  ],
  landingPage: {
    eyebrow: 'Guide for managing partners', headline: 'The rate the partners approved is not necessarily the rate clients pay',
    subheadline: 'I set out how to prepare the client conversation, decide what the first no may change and check what was invoiced ninety days later.',
    bullets: ['Give account leads an explanation they can say aloud.', 'Set the boundary for the first refusal before the call.', 'Name owners for an account-by-account invoice review.'],
    formHeading: 'Get the rate-change guide', buttonLabel: 'Download the guide',
  },
  sourceReferences: [
    { claim: 'The review figures', quote: 'Last year we reviewed 40 pricing changes at services firms. 31 of them were approved unanimously by the partners. And 19 of those 31 had quietly reverted within 90 days.', speaker: 'Maya Chen', timestamp: '00:45' },
    { claim: 'The handover', quote: 'The spreadsheet was never the problem. The handover was.', speaker: 'Maya Chen', timestamp: '01:09' },
  ],
  carousel: {
    title: 'Will the approved rate reach the invoice?',
    slides: [
      { heading: 'Approval is not the finish', body: 'In our review, 19 of those 31 unanimously approved changes had quietly reverted within 90 days. These are our observations, not an industry benchmark.' },
      { heading: 'Give account leads an explanation', body: 'A number and start date do not prepare a client conversation. I would ask the partner who argued for the change to write the explanation.' },
      { heading: 'Test the client sentence', body: 'Explain what changed and why it is worth it to the client. Prepare for the first objection. Ask the account lead to say both aloud.' },
      { heading: 'Prepare for the old‑rate question', body: 'I would not treat a request for the old rate as an automatic reason to concede. Practise how to answer it.' },
      { heading: 'Set the boundary before the call', body: 'Scope or payment terms may flex. The rate does not move in the first conversation. Agree that distinction before announcing the change.' },
      { heading: 'Check what was invoiced', body: 'Schedule a ninety-day review with named owners. Compare intended rates with invoices, account by account.' },
    ],
    closing: 'Get the full guide to prepare the handover before your rate announcement.',
  },
};

const now = new Date().toISOString();
const project: Project = {
  id: `sample-northstar-${Date.now()}`, status: 'rendering', progress: 88, createdAt: now, updatedAt: now,
  transcript: '', reviewToken: 'sample', events: [], mode: 'live', intake, brand, bundle,
};

const artifacts = await renderArtifacts(project);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const files = [artifacts.pdf, artifacts.carouselPdf, ...(artifacts.carouselSlides ?? []), ...(artifacts.postCards ?? []),
  ...(artifacts.motionClips ?? []).flatMap((clip) => [clip.file, clip.poster])].filter(Boolean) as string[];
for (const file of files) await cp(file, path.join(out, path.basename(file)));
console.log(JSON.stringify({ out, design: artifacts.designSummary, notes: artifacts.notes, files: files.map((f) => path.basename(f)) }, null, 2));
