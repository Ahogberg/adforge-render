import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Browser } from 'playwright';
import { displayQuote, escapeHtml, type DesignSystem } from './design.js';
import { encodeJpegFrames, ffmpegAvailable } from './media.js';
import { expertParts, loadDocument, socialDocument, SOCIAL_HEIGHT, SOCIAL_WIDTH } from './social.js';
import { effectiveLayout, type CampaignBundle, type Project, type VideoArtifact } from './types.js';

export const MOTION_FPS = 30;
const MAX_CLIPS = 2;

export type MotionSpec =
  | { kind: 'stat'; setup: string; value: string; label: string; payoff: string; timestamp: string }
  | { kind: 'quote'; quote: string; timestamp?: string };

/**
 * Chooses the clips from content that already passed the source checks: guide figures
 * (verified near their timestamp) and pull quotes (verified verbatim). Nothing new is written.
 */
export function planMotionClips(bundle: CampaignBundle): MotionSpec[] {
  const specs: MotionSpec[] = [];
  const statSection = bundle.sections.find((section) => effectiveLayout(section) === 'stat' && section.stat);
  if (statSection?.stat) {
    specs.push({ kind: 'stat', setup: statSection.stat.context, value: statSection.stat.value, label: statSection.stat.label, payoff: statSection.title, timestamp: statSection.stat.sourceTimestamp });
  }
  const quotes = bundle.sections
    .filter((section) => section !== statSection && section.pullQuote)
    .map((section) => ({ quote: section.pullQuote as string, timestamp: section.sourceTimestamp }))
    .filter(({ quote }) => { const words = quote.trim().split(/\s+/).length; return words >= 5 && words <= 28; })
    // Complete sentences make better clips than fragments; shorter quotes read better in motion.
    .sort((a, b) => Number(/^[a-z]/.test(a.quote)) - Number(/^[a-z]/.test(b.quote)) || a.quote.length - b.quote.length);
  for (const quote of quotes) {
    if (specs.length >= MAX_CLIPS) break;
    specs.push({ kind: 'quote', quote: quote.quote, timestamp: quote.timestamp });
  }
  return specs.slice(0, MAX_CLIPS);
}

export async function renderMotionClips(browser: Browser, project: Project, design: DesignSystem, directory: string): Promise<{ clips: VideoArtifact[]; notes: string[] }> {
  if (!project.bundle) return { clips: [], notes: [] };
  const specs = planMotionClips(project.bundle);
  if (!specs.length) return { clips: [], notes: ['No verified figure or pull quote suitable for a motion clip.'] };
  if (!(await ffmpegAvailable())) return { clips: [], notes: ['Motion clips skipped: ffmpeg is not installed on this server.'] };
  const outDir = path.join(directory, 'motion');
  await mkdir(outDir, { recursive: true });
  const clips: VideoArtifact[] = [];
  const notes: string[] = [];
  const page = await browser.newPage({ viewport: { width: SOCIAL_WIDTH, height: SOCIAL_HEIGHT }, deviceScaleFactor: 1 });
  try {
    for (const [index, spec] of specs.entries()) {
      const name = `${spec.kind === 'stat' ? 'figure' : 'quote'}-clip-${String(index + 1).padStart(2, '0')}`;
      const file = path.join(outDir, `${name}.mp4`);
      const partial = path.join(outDir, `.${name}.partial.mp4`);
      const poster = path.join(outDir, `${name}.poster.jpg`);
      try {
        await loadDocument(page, socialDocument(design, sceneHtml(project, design, spec), SCENE_CSS));
        const duration = await page.evaluate(() => (window as unknown as { setupScene: () => number }).setupScene());
        const frames = Math.round(duration * MOTION_FPS);
        const encoder = encodeJpegFrames(partial, MOTION_FPS);
        try {
          for (let frame = 0; frame < frames; frame += 1) {
            await page.evaluate((t) => (window as unknown as { renderFrame: (time: number) => void }).renderFrame(t), frame / MOTION_FPS);
            await encoder.write(await page.screenshot({ type: 'jpeg', quality: 92 }));
          }
          await encoder.finish();
        } catch (error) {
          encoder.abort();
          throw error;
        }
        // Only a complete file ever gets the final name, so a failed clip never reaches the delivery zip.
        await rename(partial, file);
        await writeFile(poster, await page.screenshot({ type: 'jpeg', quality: 85 }));
        clips.push({ file, poster, kind: spec.kind, durationSeconds: frames / MOTION_FPS, title: spec.kind === 'stat' ? `${spec.value} ${spec.label}` : displayQuote(spec.quote) });
      } catch (error) {
        await rm(partial, { force: true });
        notes.push(`Motion clip ${index + 1} could not be rendered: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await page.close();
  }
  return { clips, notes };
}

const SCENE_CSS = `
.stage{position:relative;width:${SOCIAL_WIDTH}px;height:${SOCIAL_HEIGHT}px;overflow:hidden;background:var(--dark);color:var(--on-dark)}
.glow{position:absolute;inset:0;background:radial-gradient(900px 700px at 86% 6%,color-mix(in srgb,var(--accent-on-dark) 16%,transparent),transparent 62%)}
.abs{position:absolute;left:96px;right:96px}
.topbar{top:96px;display:flex;justify-content:space-between;color:var(--muted-on-dark)}
.topbar b{color:var(--on-dark);font-weight:600}
.topline{top:152px;height:3px;background:var(--accent-on-dark);transform-origin:left}
.w{display:inline-block;white-space:pre;will-change:transform,opacity}
.setup{top:232px;max-height:300px;font-size:80px;line-height:1.1}
.grid{top:660px;left:96px;right:auto;display:grid;gap:12px}
.sq{border-radius:4px;box-shadow:inset 0 0 0 2px var(--rule-on-dark)}
.stats{position:absolute;top:640px;right:72px}
.stat .n{font-family:var(--font-display);font-weight:600;font-size:118px;line-height:1;letter-spacing:-.03em;font-variant-numeric:lining-nums tabular-nums}
.stat .of{margin-top:6px;font-family:var(--font-display);font-size:48px;line-height:1.1;color:var(--accent-on-dark)}
.stat .t{margin-top:18px;font:500 31px/1.3 var(--font-text);color:var(--muted-on-dark)}
.big{top:600px;text-align:left}
.big .n{max-height:300px;font-size:250px;line-height:1;color:var(--accent-on-dark)}
.big .t{margin-top:22px;max-height:160px;font-size:44px;line-height:1.28;color:var(--on-dark);font-family:var(--font-text);font-weight:500}
.payoff{top:420px;max-height:420px;font-size:96px;line-height:1.06}
.underline{left:96px;right:auto;height:6px;background:var(--accent-on-dark);transform-origin:left;border-radius:3px}
.mark{top:200px;font-family:var(--font-display);font-size:300px;line-height:1;height:200px;color:var(--accent-on-dark);transform-origin:20% 70%}
.quote{top:430px;max-height:520px;font-size:84px;line-height:1.1}
.source{top:1010px;display:flex;align-items:center;gap:14px;color:var(--muted-on-dark)}
.source i{width:12px;height:12px;border-radius:50%;background:var(--accent-on-dark)}
.footline{top:1068px;height:2px;background:var(--rule-on-dark);transform-origin:left}
.foot{top:1108px;display:flex;justify-content:space-between;align-items:center}
.who strong{display:block;font:600 38px/1.2 var(--font-text)}
.who span{display:block;margin-top:8px;font:500 28px/1.3 var(--font-text);color:var(--muted-on-dark)}
.chip{padding:22px 28px;border:2px solid var(--accent-on-dark);border-radius:6px;color:var(--accent-on-dark);font:600 28px/1 var(--font-text)}
`;

function sceneHtml(project: Project, design: DesignSystem, spec: MotionSpec): string {
  const expert = expertParts(project);
  const sourceType = project.intake.sourceType;
  const cta = project.bundle?.landingPage.buttonLabel || 'Get the guide';
  const chrome = `
    <div class="abs topbar label" id="top"><span><b>${escapeHtml(project.intake.companyName)}</b></span><span>From the ${escapeHtml(sourceType)}</span></div>
    <div class="abs topline" id="topline"></div>
    <div class="abs source label" id="source"><i></i><span>Source · ${escapeHtml(sourceType)}${spec.timestamp ? ` ${escapeHtml(spec.timestamp)}` : ''}</span></div>
    <div class="abs footline" id="footline"></div>
    <div class="abs foot" id="foot"><div class="who"><strong>${escapeHtml(expert.name)}</strong>${expert.role ? `<span>${escapeHtml(expert.role)}</span>` : ''}</div><div class="chip">${escapeHtml(cta)}</div></div>`;
  const words = (text: string) => escapeHtml(text).split(/\s+/).map((word) => `<span class="w">${word} </span>`).join('');
  const body = spec.kind === 'stat' ? statBody(spec, words) : quoteBody(spec, words);
  return `<div class="stage"><div class="glow"></div>${chrome}${body}</div><script>${SCENE_SCRIPT}\nwindow.SPEC=${scriptJson({ kind: spec.kind, ...(spec.kind === 'stat' ? { value: spec.value } : {}), accent: design.palette.accentOnDark })};</script>`;
}

/** JSON that is safe inside an inline <script>: model text can never close the tag. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function statBody(spec: Extract<MotionSpec, { kind: 'stat' }>, words: (text: string) => string): string {
  const ratio = spec.value.match(/^\s*(\d+)\s+(?:of|out of|in)\s+(\d+)\b/i);
  const unitized = ratio && Number(ratio[2]) <= 60 && Number(ratio[1]) <= Number(ratio[2]);
  const viz = unitized
    ? `<div class="abs grid" id="grid" data-of="${ratio[1]}" data-total="${ratio[2]}"></div>
       <div class="stats" id="stats"><div class="stat"><div class="n" id="counter">0</div><div class="of">of ${ratio[2]}</div><div class="t">${escapeHtml(spec.label)}</div></div></div>`
    : `<div class="abs big" id="stats"><div class="n display fit" id="counter" data-max="250" data-min="120">${escapeHtml(spec.value)}</div><p class="t fit" data-max="44" data-min="30">${escapeHtml(spec.label)}</p></div>`;
  return `<div class="abs setup display fit" id="setup" data-max="80" data-min="52">${words(spec.setup)}</div>
    ${viz}
    <div class="abs payoff display fit" id="payoff" data-max="96" data-min="58">${words(spec.payoff)}</div>
    <div class="abs underline" id="underline"></div>`;
}

function quoteBody(spec: Extract<MotionSpec, { kind: 'quote' }>, words: (text: string) => string): string {
  return `<div class="abs mark" id="mark">“</div><div class="abs quote display fit" id="quote" data-max="104" data-min="50">${words(displayQuote(spec.quote))}</div>`;
}

/** Runs in the page: deterministic, frame-addressable animation (no timers), so every render is identical. */
const SCENE_SCRIPT = String.raw`
var $=function(id){return document.getElementById(id)};
var clamp=function(v){return Math.min(1,Math.max(0,v))};
var p=function(t,s,d){return clamp((t-s)/d)};
var outCubic=function(x){return 1-Math.pow(1-x,3)};
var inOut=function(x){return x<.5?4*x*x*x:1-Math.pow(-2*x+2,3)/2};
var outExpo=function(x){return x===1?1:1-Math.pow(2,-10*x)};
var T={};
function hex(c){var m=c.replace('#','');return[parseInt(m.slice(0,2),16),parseInt(m.slice(2,4),16),parseInt(m.slice(4,6),16)]}
function words(el,t,start,stagger,dur,rise){if(!el)return;[].forEach.call(el.children,function(w,i){var k=outCubic(p(t,start+i*stagger,dur));w.style.opacity=k;w.style.transform='translateY('+((1-k)*rise)+'px)'})}
function fadeUp(el,t,start,dur,rise){if(!el)return;var k=outCubic(p(t,start,dur));el.style.opacity=k;el.style.transform='translateY('+((1-k)*(rise||24))+'px)'}
function counterParts(value){var m=value.match(/^(\D*?)(\d+(?:[.,]\d+)?)(.*)$/);if(!m)return null;var raw=m[2].replace(',','.');return{prefix:m[1],n:parseFloat(raw),decimals:(raw.split('.')[1]||'').length,suffix:m[3],sep:m[2].indexOf(',')>=0?',':'.'}}
window.setupScene=function(){
  var s=window.SPEC;
  if(s.kind==='stat'){
    var setupWords=$('setup').children.length;T.setupEnd=0.3+setupWords*0.07+0.55;
    T.vizStart=Math.max(2.0,T.setupEnd+0.1);T.exit=T.vizStart+3.9;T.payoff=T.exit+0.55;
    var payoffWords=$('payoff').children.length;T.payoffEnd=T.payoff+payoffWords*0.09+0.7;
    T.outro=T.payoffEnd+0.6;T.end=T.outro+2.3;
    var grid=$('grid');
    if(grid){var total=+grid.dataset.total,cols=Math.min(10,Math.max(4,Math.ceil(Math.sqrt(total*1.6)))),size=Math.min(64,Math.floor((500-(cols-1)*12)/cols));
      grid.style.gridTemplateColumns='repeat('+cols+','+size+'px)';
      for(var i=0;i<total;i++){var d=document.createElement('div');d.className='sq';d.style.width=d.style.height=size+'px';grid.appendChild(d)}
      $('stats').style.left=(96+cols*size+(cols-1)*12+56)+'px';}
    var pay=$('payoff');$('underline').style.top=(pay.offsetTop+pay.offsetHeight+38)+'px';$('underline').style.width='200px';
  } else {
    var qWords=$('quote').children.length,stagger=Math.max(0.06,Math.min(0.14,3.6/qWords));
    T.quoteStart=0.55;T.stagger=stagger;T.quoteEnd=T.quoteStart+qWords*stagger+0.7;T.outro=Math.max(T.quoteEnd+0.9,5.2);T.end=T.outro+3.2;
  }
  window.renderFrame(0);return T.end;
};
window.renderFrame=function(t){
  var s=window.SPEC;
  fadeUp($('top'),t,0,0.5,14);
  $('topline').style.transform='scaleX('+inOut(p(t,0.1,0.8))+')';
  if(s.kind==='stat'){
    var exit=inOut(p(t,T.exit,0.6));
    ['setup','grid','stats'].forEach(function(id){var el=$(id);if(el){el.style.opacity=1-exit;el.style.translate='0 '+(-60*exit)+'px'}});
    words($('setup'),t,0.3,0.07,0.55,46);
    var grid=$('grid');
    if(grid){var of=+grid.dataset.of,total=+grid.dataset.total,acc=hex(s.accent);
      [].forEach.call(grid.children,function(sq,i){var a=outCubic(p(t,T.vizStart+i*0.02,0.35));var f=outCubic(p(t,T.vizStart+0.8+i*0.025,0.35));
        sq.style.transform='scale('+(0.6+0.4*a)+')';sq.style.opacity=a*(1-exit);
        sq.style.background=i<of?'rgba('+acc.join(',')+','+f+')':'transparent'})}
    var stats=$('stats');var k=outCubic(p(t,T.vizStart+0.6,0.5));stats.style.opacity=k*(1-exit);stats.style.transform='translateY('+((1-k)*24)+'px)';
    var parts=counterParts(s.value),counter=$('counter');
    if(parts&&grid){var c=outExpo(p(t,T.vizStart+0.8,1.4));counter.textContent=String(Math.round(+grid.dataset.of*c))}
    else if(parts){var c2=outExpo(p(t,T.vizStart+0.5,1.4));counter.textContent=parts.prefix+(parts.n*c2).toFixed(parts.decimals).replace('.',parts.sep)+parts.suffix}
    words($('payoff'),t,T.payoff,0.09,0.7,54);
    $('underline').style.transform='scaleX('+inOut(p(t,T.payoffEnd-0.2,0.7))+')';
  } else {
    var m=outCubic(p(t,0.15,0.7));$('mark').style.opacity=m;$('mark').style.transform='scale('+(0.7+0.3*m)+')';
    words($('quote'),t,T.quoteStart,T.stagger,0.6,50);
  }
  fadeUp($('source'),t,T.outro,0.6,16);
  $('footline').style.transform='scaleX('+inOut(p(t,T.outro+0.1,0.8))+')';
  fadeUp($('foot'),t,T.outro+0.3,0.7,20);
};`;
