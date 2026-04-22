// render-server.js
// Deploy on Railway.app — handles ebook PDF, landing page HTML, and brand scraping
//
// Setup:
//   npm install express playwright
//   npx playwright install chromium
//   node render-server.js

const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));

const EBOOK_TEMPLATE   = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const LANDING_TEMPLATE = fs.readFileSync(path.join(__dirname, 'landing-template.html'), 'utf8');

function fillTemplate(template, data) {
  let html = template;
  for (const [key, value] of Object.entries(data)) {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    html = html.replace(regex, (value || '').toString());
  }
  return html;
}

app.get('/health', (req, res) => res.json({ status: 'ok', endpoints: ['/render', '/landing', '/scrape'] }));

// POST /render { templateData } → PDF binary
app.post('/render', async (req, res) => {
  const { templateData } = req.body;
  if (!templateData) return res.status(400).json({ error: 'templateData required' });

  const id = crypto.randomBytes(6).toString('hex');
  const htmlPath = `/tmp/ebook-${id}.html`;
  const pdfPath  = `/tmp/ebook-${id}.pdf`;

  try {
    fs.writeFileSync(htmlPath, fillTemplate(EBOOK_TEMPLATE, templateData), 'utf8');
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const page = await browser.newPage();
    await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
    await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top:'0',right:'0',bottom:'0',left:'0' } });
    await browser.close();
    const pdf = fs.readFileSync(pdfPath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="ebook.pdf"');
    res.send(pdf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    try { fs.unlinkSync(htmlPath); } catch {}
    try { fs.unlinkSync(pdfPath); } catch {}
  }
});

// POST /landing { landingData } → HTML file download
app.post('/landing', async (req, res) => {
  const { landingData } = req.body;
  if (!landingData) return res.status(400).json({ error: 'landingData required' });

  try {
    const html = fillTemplate(LANDING_TEMPLATE, landingData);
    const slug = (landingData.COMPANY_SLUG || 'landing').toLowerCase().replace(/\s+/g, '-');
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-landing-page.html"`);
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /scrape { url } → brand signals JSON
app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

    const brand = await page.evaluate(() => {
      const cs = el => el ? getComputedStyle(el) : null;
      const header = document.querySelector('header, nav, [class*="header"], [class*="nav"]');
      const hero   = document.querySelector('.hero, [class*="hero"], main h1, h1');
      const btn    = document.querySelector('[class*="btn-primary"], [class*="button--primary"], [class*="cta"]');
      const logo   = document.querySelector('header img, nav img, [class*="logo"] img');

      const googleFonts = [...document.querySelectorAll('link[href*="fonts.googleapis"]')]
        .map(l => l.href.match(/family=([^&:]+)/)?.[1]?.replace(/\+/g,' ') || '')
        .filter(Boolean).join(', ');

      let cssVars = '';
      try {
        const root = [...document.styleSheets]
          .flatMap(s => { try { return [...s.cssRules]; } catch { return []; } })
          .find(r => r.selectorText === ':root');
        if (root) cssVars = (root.cssText.match(/--[\w-]+:\s*#[0-9a-fA-F]{3,8}/g) || []).slice(0,15).join('; ');
      } catch {}

      return {
        url:         window.location.href,
        title:       document.title,
        description: document.querySelector('meta[name="description"]')?.content || '',
        ogImage:     document.querySelector('meta[property="og:image"]')?.content || '',
        fontFamily:  getComputedStyle(document.body).fontFamily,
        googleFonts,
        cssVars,
        logoSrc:     logo?.src || '',
        headerBg:    cs(header)?.backgroundColor || '',
        heroColor:   cs(hero)?.color || '',
        btnBg:       cs(btn)?.backgroundColor || '',
        btnColor:    cs(btn)?.color || '',
        btnRadius:   cs(btn)?.borderRadius || '',
        bodyText:    document.body.innerText?.replace(/\s+/g,' ').trim().slice(0, 3000) || ''
      };
    });

    await browser.close();
    res.json({ success: true, brand });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AdForge render server on port ${PORT}`));
