import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page } from 'playwright';
import { displayDomain, escapeHtml, waveformSvg, type DesignSystem } from './design.js';
import type { Carousel, Project, ProjectArtifacts } from './types.js';

export const SOCIAL_WIDTH = 1080;
export const SOCIAL_HEIGHT = 1350;

const ARROW = '<svg viewBox="0 0 16 16" width="26" height="26" aria-hidden="true"><path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Shared page shell for 1080x1350 social formats: fonts, tokens, and the text-fitting script. */
export function socialDocument(design: DesignSystem, body: string, extraCss = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
${design.type.css}
${design.cssVariables}
*{box-sizing:border-box;margin:0}
html,body{background:transparent}
body{font-family:var(--font-text);color:var(--ink);-webkit-font-smoothing:antialiased}
.frame{position:relative;width:${SOCIAL_WIDTH}px;height:${SOCIAL_HEIGHT}px;overflow:hidden;display:flex;flex-direction:column;padding:88px 92px 84px;page-break-after:always;break-after:page}
.frame:last-child{page-break-after:auto;break-after:auto}
.display{font-family:var(--font-display);font-weight:var(--display-weight);letter-spacing:var(--display-tracking);text-wrap:balance}
.label{font:600 25px/1.2 var(--font-text);letter-spacing:.14em;text-transform:uppercase}
.fit{overflow:hidden;flex-shrink:0}
.dark{background:var(--dark);color:var(--on-dark)}
.paper{background:var(--paper);color:var(--ink)}
.accent{background:var(--accent);color:var(--on-accent)}
.top{display:flex;justify-content:space-between;align-items:center;padding-bottom:30px;border-bottom:2px solid currentColor;border-color:var(--rule)}
.dark .top{border-color:var(--rule-on-dark)}
.accent .top{border-color:color-mix(in srgb,var(--on-accent) 26%,transparent)}
.muted{color:var(--muted)}.dark .muted{color:var(--muted-on-dark)}.accent .muted{color:var(--on-accent);opacity:.72}
.hl{color:var(--accent-text)}.dark .hl{color:var(--accent-on-dark)}.accent .hl{color:var(--on-accent)}
.wave svg{width:100%;height:100%;display:block}
${extraCss}
</style></head><body>${body}<script>
function overflows(el,size){var cs=getComputedStyle(el),limit=cs.maxHeight!=='none'?parseFloat(cs.maxHeight):el.clientHeight;/* glyphs may extend past a tight line box; allow for that */return el.scrollHeight>limit+size*0.15||el.scrollWidth>el.clientWidth+2;}
function fitAll(){document.querySelectorAll('[data-max]').forEach(function(el){var size=Number(el.dataset.max),min=Number(el.dataset.min||24);el.style.fontSize=size+'px';while(overflows(el,size)&&size>min){size-=2;el.style.fontSize=size+'px';}});}
document.fonts.ready.then(function(){fitAll();document.body.dataset.ready='1';});
</script></body></html>`;
}

export function expertParts(project: Project): { name: string; role: string } {
  const [name, ...rest] = project.intake.expertName.split(',').map((part) => part.trim()).filter(Boolean);
  return name ? { name, role: rest.join(', ') } : { name: project.intake.companyName, role: '' };
}

/** Carousel copy from the campaign, or derived from the guide for campaigns written before carousels. */
export function carouselFor(project: Project): Carousel {
  const bundle = project.bundle;
  if (!bundle) throw new Error('Campaign content is required');
  if (bundle.carousel) return bundle.carousel;
  return {
    title: bundle.title,
    slides: bundle.sections.slice(0, 7).map((section) => ({ heading: section.title, body: firstSentence(section.body[0] ?? '') })),
    closing: `The full guide goes deeper: ${bundle.title}.`,
  };
}

export async function renderSocialAssets(browser: Browser, project: Project, design: DesignSystem, directory: string): Promise<Pick<ProjectArtifacts, 'carouselPdf' | 'carouselSlides' | 'postCards'>> {
  if (!project.bundle) throw new Error('Campaign content is required');
  const outDir = path.join(directory, 'linkedin');
  await mkdir(outDir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: SOCIAL_WIDTH, height: SOCIAL_HEIGHT }, deviceScaleFactor: 1 });
  try {
    const carouselPdf = path.join(outDir, 'carousel.pdf');
    await loadDocument(page, socialDocument(design, carouselHtml(project, design), CAROUSEL_CSS));
    await page.pdf({ path: carouselPdf, width: `${SOCIAL_WIDTH}px`, height: `${SOCIAL_HEIGHT}px`, printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } });
    const carouselSlides: string[] = [];
    const frames = page.locator('.frame');
    for (let index = 0; index < await frames.count(); index += 1) {
      const file = path.join(outDir, `carousel-slide-${String(index + 1).padStart(2, '0')}.png`);
      await frames.nth(index).screenshot({ path: file });
      carouselSlides.push(file);
    }

    const postCards: string[] = [];
    await loadDocument(page, socialDocument(design, project.bundle.linkedinPosts.map((post, index) => postCardHtml(project, design, post.hook, index)).join(''), CARD_CSS));
    const cards = page.locator('.frame');
    for (let index = 0; index < await cards.count(); index += 1) {
      const file = path.join(outDir, `post-${String(index + 1).padStart(2, '0')}.png`);
      await cards.nth(index).screenshot({ path: file });
      postCards.push(file);
    }
    return { carouselPdf, carouselSlides, postCards };
  } finally {
    await page.close();
  }
}

export async function loadDocument(page: Page, html: string): Promise<void> {
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ready === '1', undefined, { timeout: 15_000 });
}

const CAROUSEL_CSS = `
.cover-title{flex:1;display:flex;flex-direction:column;justify-content:flex-end;min-height:0}
.cover-title .label{margin-bottom:34px}
.cover-title h1{max-height:600px;font-size:112px;line-height:1.02}
.cover .wave{height:120px;margin:56px 0 44px}
.foot{display:flex;justify-content:space-between;align-items:center;padding-top:30px;border-top:2px solid var(--rule-on-dark)}
.paper .foot{border-color:var(--rule)}
.accent .foot{border-color:color-mix(in srgb,var(--on-accent) 26%,transparent)}
.who strong{display:block;font:600 34px/1.2 var(--font-text)}
.who span{display:block;margin-top:6px;font:500 26px/1.3 var(--font-text)}
.swipe{display:flex;align-items:center;gap:14px}
.slide-body{flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0;padding-bottom:60px}
.slide-body .num{font:600 26px/1 var(--font-text);letter-spacing:.12em;font-variant-numeric:lining-nums}
.slide-body .rule{width:96px;height:6px;background:var(--accent);margin:34px 0 50px;border-radius:3px}
.slide-body h2{max-height:420px;font-size:108px;line-height:1.04}
.slide-body p{margin-top:52px;max-height:330px;font-size:48px;line-height:1.36;font-family:var(--font-text);text-wrap:pretty;color:color-mix(in srgb,var(--ink) 76%,transparent)}
.progress{display:flex;align-items:center;gap:28px;padding-top:30px;border-top:2px solid var(--rule)}
.progress .bar{flex:1;height:6px;border-radius:3px;background:var(--rule);overflow:hidden}
.progress .bar i{display:block;height:100%;background:var(--accent)}
.progress .label{white-space:nowrap}
.closing-body{flex:1;display:flex;flex-direction:column;justify-content:flex-end;min-height:0;padding-bottom:70px}
.closing-body h2{max-height:560px;font-size:96px;line-height:1.04}
.chip{margin-top:60px;align-self:flex-start;display:inline-flex;align-items:center;gap:18px;padding:30px 38px;border-radius:8px;background:var(--on-accent);color:var(--accent);font:650 36px/1 var(--font-text)}
`;

function carouselHtml(project: Project, design: DesignSystem): string {
  const carousel = carouselFor(project);
  const company = escapeHtml(project.intake.companyName);
  const expert = expertParts(project);
  const total = carousel.slides.length + 2;
  const counter = (index: number) => `${String(index).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
  const cover = `<section class="frame dark cover">
    <div class="top"><span class="label">${company}</span><span class="label muted">${counter(1)}</span></div>
    <div class="cover-title"><div class="label hl">From the field guide</div><h1 class="display fit" data-max="112" data-min="60">${escapeHtml(carousel.title)}</h1></div>
    <div class="wave">${waveformSvg(carousel.title, { width: 900, height: 120, bars: 72, color: design.palette.accentOnDark, opacity: 0.92 })}</div>
    <div class="foot"><div class="who"><strong>${escapeHtml(expert.name)}</strong>${expert.role ? `<span class="muted">${escapeHtml(expert.role)}</span>` : ''}</div><span class="swipe label hl">Swipe ${ARROW}</span></div>
  </section>`;
  const slides = carousel.slides.map((slide, index) => `<section class="frame paper">
    <div class="top"><span class="label">${company}</span><span class="label muted">${counter(index + 2)}</span></div>
    <div class="slide-body"><span class="num hl">${String(index + 1).padStart(2, '0')}</span><span class="rule"></span>
      <h2 class="display fit" data-max="108" data-min="56">${escapeHtml(slide.heading)}</h2>
      <p class="fit" data-max="48" data-min="30">${escapeHtml(slide.body)}</p></div>
    <div class="progress"><span class="label muted">${escapeHtml(carousel.title)}</span><span class="bar"><i style="width:${Math.round(((index + 2) / total) * 100)}%"></i></span></div>
  </section>`).join('');
  const closing = `<section class="frame accent">
    <div class="top"><span class="label">${company}</span><span class="label muted">${counter(total)}</span></div>
    <div class="closing-body"><h2 class="display fit" data-max="96" data-min="56">${escapeHtml(carousel.closing)}</h2>
      <span class="chip">${escapeHtml(project.bundle?.landingPage.buttonLabel || 'Get the guide')} ${ARROW}</span></div>
    <div class="foot"><div class="who"><strong>${escapeHtml(expert.name)}</strong>${expert.role ? `<span class="muted">${escapeHtml(expert.role)}</span>` : ''}</div><span class="label muted">${escapeHtml(displayDomain(project.intake.website))}</span></div>
  </section>`;
  return cover + slides + closing;
}

const CARD_CSS = `
.card-body{flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0;padding-bottom:40px}
.mark{font-family:var(--font-display);font-size:220px;line-height:.62;height:120px}
.card-body h2{margin-top:30px;max-height:640px;font-size:104px;line-height:1.06}
.card-foot{display:flex;justify-content:space-between;align-items:flex-end;gap:40px}
.card-foot .who strong{display:block;font:600 36px/1.2 var(--font-text)}
.card-foot .who span{display:block;margin-top:8px;font:500 27px/1.3 var(--font-text)}
.card-foot .wave{width:300px;height:64px;flex:none}
`;

const CARD_STYLES = ['dark', 'paper', 'accent'] as const;

function postCardHtml(project: Project, design: DesignSystem, hook: string, index: number): string {
  const style = CARD_STYLES[index % CARD_STYLES.length] ?? 'dark';
  const expert = expertParts(project);
  const waveColor = style === 'dark' ? design.palette.accentOnDark : style === 'accent' ? design.palette.onAccent : design.palette.accentText;
  return `<section class="frame ${style}">
    <div class="top"><span class="label">${escapeHtml(project.intake.companyName)}</span><span class="label muted">${escapeHtml(displayDomain(project.intake.website))}</span></div>
    <div class="card-body"><div class="mark hl">“</div><h2 class="display fit" data-max="104" data-min="56">${escapeHtml(hook)}</h2></div>
    <div class="card-foot"><div class="who"><strong>${escapeHtml(expert.name)}</strong>${expert.role ? `<span class="muted">${escapeHtml(expert.role)}</span>` : ''}</div>
      <div class="wave">${waveformSvg(`${hook}${index}`, { width: 300, height: 64, bars: 30, color: waveColor, opacity: 0.85 })}</div></div>
  </section>`;
}

function firstSentence(value: string): string {
  const sentence = value.trim().split(/(?<=[.!?])\s+/)[0] ?? value.trim();
  return sentence.length > 180 ? `${sentence.slice(0, 177).replace(/\s+\S*$/, '')}...` : sentence;
}
