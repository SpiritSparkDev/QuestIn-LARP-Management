// Mobile layout audit with a real browser (Playwright). Not part of CI/tests.
//
//   node scripts/mobile-audit.mjs --base http://localhost:3000 \
//        --email admin@example.org --password '…' [--out ./mobile-audit-out]
//
// Needs Playwright (npm i -g playwright, or PLAYWRIGHT_MODULE=/path/to/playwright)
// and a Chromium (PLAYWRIGHT_BROWSERS_PATH is honoured). Log in as an admin of a
// development/test instance (the "Testdaten" mode of the admin settings gives
// realistic content). Output: findings on stdout (also as JSON in the out dir)
// and one screenshot per page/state/viewport.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const base = (args.base ?? 'http://localhost:3000').replace(/\/$/, '');
const out = path.resolve(args.out ?? 'mobile-audit-out');
if (!args.email || !args.password) {
  console.error('usage: node scripts/mobile-audit.mjs --base URL --email EMAIL --password PASSWORD [--out DIR]');
  process.exit(2);
}

let playwright;
try {
  playwright = process.env.PLAYWRIGHT_MODULE
    ? createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE)
    : await import('playwright');
} catch {
  console.error('Playwright not found. Install it (npm i -g playwright) or set PLAYWRIGHT_MODULE=/path/to/node_modules/playwright');
  process.exit(2);
}
const { chromium } = playwright.default ?? playwright;

const VIEWPORTS = [
  { name: '360x740', width: 360, height: 740 },
  { name: '390x844', width: 390, height: 844 },
  { name: '430x932', width: 430, height: 932 },
  { name: '768x1024', width: 768, height: 1024 },
];

// Each state: a page plus optional steps that open a dialog/tab. A step that
// cannot find its element is reported, never silently skipped.
const STATES = [
  { name: 'dashboard', url: '/account.html' },
  { name: 'events-list', url: '/admin/events.html' },
  { name: 'events-edit', url: '/admin/events.html', steps: [{ click: '[data-edit], [data-event-edit], .event-row button, #events-list button' }] },
  { name: 'members-list', url: '/admin/members.html' },
  { name: 'members-detail', url: '/admin/members.html', steps: [{ click: 'tbody tr, .member-card, [data-member]' }] },
  { name: 'characters', url: '/account.html#characters' },
  { name: 'checkin', url: '/admin/checkin.html' },
  { name: 'tavern', url: '/admin/tavern.html' },
  { name: 'settings', url: '/admin/settings.html' },
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const findings = [];

// Log in once and reuse the session: the login endpoint is rate limited.
const loginContext = await browser.newContext();
const loginRes = await loginContext.request.post(`${base}/auth/login`, { data: { email: args.email, password: args.password } });
if (!loginRes.ok()) { console.error(`login failed (${loginRes.status()})`); await browser.close(); process.exit(2); }
const storageState = await loginContext.storageState();
await loginContext.close();

// Runs inside the page: what sticks out sideways, what is too small to tap.
function measure() {
  const vw = document.documentElement.clientWidth;
  const label = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    const text = ['BUTTON', 'A'].includes(el.tagName) ? ` "${(el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 24)}"` : '';
    return `${el.tagName.toLowerCase()}${id}${cls}${text}`;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const inFixed = (el) => {
    for (let p = el; p; p = p.parentElement) if (getComputedStyle(p).position === 'fixed') return true;
    return false;
  };
  const inScrollable = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };
  const overflow = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || inScrollable(el) || inFixed(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 && getComputedStyle(el).position !== 'fixed') overflow.push(`${label(el)} (right ${Math.round(r.right)} > ${vw})`);
  }
  const small = [];
  for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button]')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if ((r.height < 36 || r.width < 36) && !(el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type))) {
      small.push(`${label(el)} "${(el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  const dialogs = [...document.querySelectorAll('dialog[open]')].map((d) => {
    const r = d.getBoundingClientRect();
    return { label: label(d), tooTall: r.height > window.innerHeight + 1 && getComputedStyle(d).overflowY === 'visible', right: Math.round(r.right), vw };
  });
  return {
    pageOverflowX: document.documentElement.scrollWidth > vw + 1,
    scrollWidth: document.documentElement.scrollWidth,
    overflow: [...new Set(overflow)].slice(0, 12),
    smallTargets: small.length,
    smallExamples: small.slice(0, 6),
    dialogs,
  };
}

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({
    storageState,
    viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2, isMobile: vp.width < 768, hasTouch: vp.width <= 1024,
  });
  for (const state of STATES) {
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e.message)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    const entry = { state: state.name, viewport: vp.name, notes: [] };
    try {
      await page.goto(base + state.url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(400);
      for (const step of state.steps ?? []) {
        const target = page.locator(step.click).first();
        if (await target.count() === 0) { entry.notes.push(`step not found: ${step.click}`); continue; }
        await target.click({ timeout: 3000 }).catch((e) => entry.notes.push(`click failed: ${String(e.message).split('\n')[0]}`));
        await page.waitForTimeout(500);
      }
      Object.assign(entry, await page.evaluate(measure));
      await page.screenshot({ path: path.join(out, `${state.name}-${vp.name}.png`), fullPage: true });
    } catch (err) {
      entry.notes.push(`error: ${String(err.message).split('\n')[0]}`);
    }
    entry.consoleErrors = [...new Set(consoleErrors)].slice(0, 5);
    findings.push(entry);
    await page.close();
  }
  await context.close();
}
await browser.close();

writeFileSync(path.join(out, 'findings.json'), JSON.stringify(findings, null, 2));
let blocking = 0;
for (const f of findings) {
  const problems = [];
  if (f.pageOverflowX) { problems.push(`horizontal scroll (scrollWidth ${f.scrollWidth})`); blocking += 1; }
  if (f.dialogs?.some((d) => d.tooTall)) { problems.push('dialog taller than screen without scrolling'); blocking += 1; }
  if (f.overflow?.length) problems.push(`sticks out: ${f.overflow.slice(0, 4).join('; ')}`);
  if (f.smallTargets) problems.push(`${f.smallTargets} small tap targets, e.g. ${f.smallExamples.slice(0, 3).join(' | ')}`);
  if (f.consoleErrors?.length) problems.push(`console: ${f.consoleErrors.join(' | ')}`);
  problems.push(...f.notes);
  console.log(`${problems.length ? '✗' : '✓'} ${f.state} @ ${f.viewport}${problems.length ? `\n    ${problems.join('\n    ')}` : ''}`);
}
console.log(`\nblocking findings: ${blocking}  (details + screenshots in ${out})`);
process.exit(blocking ? 1 : 0);
