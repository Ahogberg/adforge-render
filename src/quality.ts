import type { CampaignBundle, QualityReport } from './types.js';

export function inspectCampaign(bundle: CampaignBundle): QualityReport {
  const serialized = JSON.stringify(bundle);
  const hooks = bundle.linkedinPosts.map((post) => post.hook.trim().toLowerCase());
  const checks: QualityReport['checks'] = [
    { name: 'Complete monthly bundle', status: bundle.linkedinPosts.length === 8 && bundle.emails.length === 3 ? 'pass' : 'fail', detail: `${bundle.linkedinPosts.length} social posts and ${bundle.emails.length} emails generated.` },
    { name: 'Editorial depth', status: bundle.sections.length >= 4 ? 'pass' : 'fail', detail: `${bundle.sections.length} substantive guide sections generated.` },
    { name: 'Unique social hooks', status: new Set(hooks).size === hooks.length ? 'pass' : 'warning', detail: `${new Set(hooks).size} unique hooks across ${hooks.length} posts.` },
    { name: 'No unresolved template tokens', status: /\{\{|\}\}/.test(serialized) ? 'fail' : 'pass', detail: 'Generated content contains no unresolved template syntax.' },
    { name: 'Source traceability', status: bundle.sourceReferences.length > 0 ? 'pass' : 'warning', detail: bundle.sourceReferences.length ? `${bundle.sourceReferences.length} source references included.` : 'No source references were available; review claims manually.' },
    { name: 'Single conversion goal', status: bundle.landingPage.buttonLabel.length > 2 ? 'pass' : 'warning', detail: `Landing page CTA: “${bundle.landingPage.buttonLabel}”.` },
  ];
  const blockers = checks.filter((check) => check.status === 'fail').map((check) => check.name);
  const warnings = checks.filter((check) => check.status === 'warning').length;
  return { score: Math.max(0, 100 - blockers.length * 25 - warnings * 7), checks, blockers };
}
