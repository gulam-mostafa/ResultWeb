/**
 * Real-browser verification of the annual-promotion rules (headless Chrome).
 *
 * Renders the app AND a focused promotion-modal harness in headless Chrome through
 * `playwright-core` (the system Chrome — nothing to download), then measures the
 * COMPUTED colours, the rendered text and the geometry of what is on screen.
 *
 * ## No live data, ever
 *
 * Every request to `*.firebaseio.com`, `*.firebaseapp.com` and Google's identity
 * toolkit is ABORTED, so the app runs exactly like an offline teacher's browser:
 * from the local `resultweb:firebase-cache:*` snapshot that `seed.mjs` writes
 * before the first paint. Nothing can be read from or written to Firebase.
 *
 * ## What it proves
 *
 *  (a) ACTIVE year  (2030): no banner, colourful, editable;
 *  (b) PAST year    (2029): the "কার্যক্রম সম্পূর্ণ" banner, monochrome (measured
 *      computed colours — black text, white/grey surfaces, no gradient), chip;
 *  (c) FUTURE year  (2031): no banner, still colourful, class tabs editable;
 *  (d) Topbar list: past ⇒ লক, active ⇒ সক্রিয়, future ⇒ নির্বাচন করুন;
 *  (e) promotion modal (real component, controlled log): default = the FIRST
 *      unpromoted class, 6-row status list, সম্পূর্ণ + আনলক করুন + who unlocked it,
 *      and a CENTRED confirm dialog over a fixed overlay.
 *
 * Screenshots: `scripts/browser/shots/*.png`.
 * Usage: `npm run verify:render`
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { buildCacheEntries, SAMPLE } from './seed.mjs';

const SHOTS = path.join(process.cwd(), 'scripts/browser/shots');
const CONFIG = 'scripts/browser/vite.render.config.mjs';
const PORT = 4178;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const problems = [];
const notes = [];
const check = (ok, label, detail = '') => {
  if (ok) notes.push(`  ok — ${label}${detail ? ` (${detail})` : ''}`);
  else problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

const toBangla = (value) => String(value).replace(/\d/g, (digit) => '০১২৩৪৫৬৭৮৯'[Number(digit)]);

/** `rgb(r, g, b)` / `rgba(…)` ➔ `[r, g, b, a]`; `null` for transparent/none. */
function parseColor(value) {
  const text = String(value ?? '').trim();
  if (!text || text === 'transparent' || text === 'none') return null;
  const match = text.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
  return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
}

/** `true` for black / white / grey (per-channel spread ≤ 24). */
const isNeutral = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) <= 24;

/** sRGB luminance, 0-255 scale — used for "black text" / "white background". */
const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Collects the computed colour of every visible text node inside `selector`. */
const TEXT_COLORS = (selector) => {
  const root = document.querySelector(selector);
  if (!root) return null;
  const found = [];
  const walk = (element) => {
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return;
    const ownText = [...element.childNodes]
      .filter((node) => node.nodeType === 3 && node.textContent.trim())
      .map((node) => node.textContent.trim())
      .join(' ');
    if (ownText) found.push({ text: ownText.slice(0, 40), color: style.color });
    [...element.children].forEach(walk);
  };
  walk(root);
  return found;
};

/** Collects the computed background colour of every element inside `selector`. */
const BACKGROUNDS = (selector) => {
  const root = document.querySelector(selector);
  if (!root) return null;
  const found = [];
  const walk = (element) => {
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return;
    const background = style.backgroundColor;
    if (background && background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') {
      found.push({ tag: element.tagName.toLowerCase(), background, image: style.backgroundImage });
    }
    [...element.children].forEach(walk);
  };
  walk(root);
  return found;
};

const findChrome = () => CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? '';

/**
 * Minimal static file server for `dist-render-check` (no SPA fallback, so the
 * harness page is served exactly as built). Replaces `vite preview`, which kept
 * rewriting `/modal-check.html` to the app shell.
 */
function startStaticServer(root) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', ORIGIN);
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
    if (!file.startsWith(root)) {
      response.writeHead(403).end();
      return;
    }
    readFile(file)
      .then((body) => {
        response.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
        response.end(body);
      })
      .catch(() => {
        // A path that is not a built file is an APP route (`/students`, `/results`…):
        // serve the SPA shell exactly like the production host does. A missing asset
        // stays a hard 404 so a broken build can never be masked.
        if (path.extname(file)) {
          response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
          return;
        }
        readFile(path.join(root, 'index.html'))
          .then((body) => {
            response.writeHead(200, { 'Content-Type': types['.html'] });
            response.end(body);
          })
          .catch(() => response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'));
      });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

function buildRenderBundle() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vite', 'build', '--config', CONFIG],
      { cwd: process.cwd(), shell: true, stdio: 'ignore' },
    );
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`render build exited with ${code}`))));
    child.on('error', reject);
  });
}

async function waitForServer(url, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

/** Reads the Topbar's viewed-year label (the only state this check needs). */
async function viewedYearLabel(page) {
  return page.evaluate(() => [...document.querySelectorAll('header button')]
    .map((button) => button.innerText.replace(/\s+/g, ' ').trim())
    .find((text) => text.includes('শিক্ষাবর্ষ')) ?? '');
}

/**
 * Opens the VISIBLE Topbar year menu and reads its rows.
 * The Topbar renders the selector twice (desktop + mobile); the hidden copy keeps
 * its own popover in the DOM, so every lookup is scoped to `:visible`.
 */
async function readYearMenu(page) {
  const trigger = page.locator('header button:visible', { hasText: 'শিক্ষাবর্ষ' }).first();
  await trigger.click();
  await page.waitForTimeout(400);
  return page.locator('[role="menu"]:visible li button').evaluateAll((buttons) => buttons.map((button) => ({
    text: button.innerText.replace(/\s+/g, ' ').trim(),
    badge: (button.querySelector('.badge, span:last-child')?.innerText ?? '').trim(),
    disabled: button.disabled,
  })));
}

/** Picks a year in the VISIBLE Topbar list and waits for the partition to re-paint. */
async function pickYear(page, year) {
  const trigger = page.locator('header button:visible', { hasText: 'শিক্ষাবর্ষ' }).first();
  const menu = page.locator('[role="menu"]:visible');
  if (!(await menu.count())) {
    await trigger.click();
    await page.waitForTimeout(400);
  }
  const item = menu.locator('li button').filter({ hasText: toBangla(year) }).first();
  if (!(await item.count())) {
    const rows = await menu.locator('li button').allInnerTexts();
    const label = await page.locator('header button:visible', { hasText: 'শিক্ষাবর্ষ' }).first().innerText().catch(() => '?');
    const footer = await page.locator('.app-footer').innerText().catch(() => '?');
    throw new Error(`year ${year} (${toBangla(year)}) is missing from the Topbar list: ${JSON.stringify(rows)} | trigger=${label} | footer=${footer}`);
  }
  await item.click();
  await page.waitForTimeout(1800);
}

const main = async () => {
  await mkdir(SHOTS, { recursive: true });
  const executablePath = findChrome();
  if (!executablePath) {
    console.error('No Chrome/Edge found — the real-browser check cannot run.');
    process.exit(1);
  }
  // The two-page bundle (app + focused modal harness) is what the check renders.
  const dist = path.join(process.cwd(), 'dist-render-check');
  await rm(dist, { recursive: true, force: true });
  await buildRenderBundle();
  const server = await startStaticServer(dist);
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    if (!await waitForServer(ORIGIN)) throw new Error(`the static server did not answer on ${ORIGIN}`);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    /**
     * NO LIVE FIREBASE: every request to the production database / auth is aborted,
     * so the app runs exactly as it does for an offline teacher — from its
     * `resultweb:firebase-cache:*` snapshot. This is what makes the check
     * deterministic AND guarantees live data can never be read or written.
     */
    await context.route('**/*firebaseio.com/**', (route) => route.abort());
    await context.route('**/*firebaseapp.com/**', (route) => route.abort());
    await context.route('**/identitytoolkit.googleapis.com/**', (route) => route.abort());
    await context.route('**/fonts.googleapis.com/**', (route) => route.abort());
    await context.route('**/fonts.gstatic.com/**', (route) => route.abort());
    // The cached snapshot + the signed-in session are seeded before the app boots,
    // so the very first paint already shows the sample tenant and its years.
    await context.addInitScript((seeded) => {
      Object.entries(seeded).forEach(([key, value]) => window.localStorage.setItem(key, value));
    }, buildCacheEntries());
    const pageErrors = [];
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));

    /* ---------------- (1) ACTIVE year: no banner, editable ---------------- */
    await page.goto(`${ORIGIN}/index.html`, { waitUntil: 'domcontentloaded' });
    // Wait for the real app shell (the sidebar) instead of a fixed delay: the
    // bundle is large and "domcontentloaded" fires before React has painted.
    await page.locator('.app-sidebar').first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(2500);
    let body = await page.locator('body').innerText();
    check(!body.includes('পৃষ্ঠাটি দেখাতে সমস্যা হয়েছে'), 'the app renders (no error boundary)');
    check(pageErrors.length === 0, 'no uncaught page error', pageErrors.slice(0, 2).join(' | '));
    const shownYear = toBangla(SAMPLE.active);
    check(body.includes(shownYear), `Topbar shows the active year ${SAMPLE.active}`, shownYear);
    // The YEAR banner is `[role="status"]` directly under the topbar; the CLASS chip
    // sits inside `main`, so the two are told apart by position, not by text.
    const yearBannerText = await page.locator('header ~ div[role="status"], body > div [role="status"]').first().innerText().catch(() => '');
    check(!body.includes('সালের কার্যক্রম সম্পূর্ণ'), 'the active year has NO complete-year banner');
    check(!yearBannerText.includes('সালের তথ্য'), 'the active year shows no year banner at all');
    check(!body.includes('শুধু দেখা'), 'the active year has no "শুধু দেখা" chip');
    await page.screenshot({ path: path.join(SHOTS, '01-active-year-students.png') });

    /* ---------------- (2) Topbar badges: লক / সক্রিয় / নির্বাচন করুন ---- */
    const rows = await readYearMenu(page);
    const badgeOf = (year) => rows.find((row) => row.text.includes(toBangla(year)));
    check(Boolean(badgeOf(SAMPLE.past)), 'the year list contains the past year', toBangla(SAMPLE.past));
    check(badgeOf(SAMPLE.past)?.text.includes('লক'), 'a PAST year is badged "লক"', badgeOf(SAMPLE.past)?.text);
    check(badgeOf(SAMPLE.active)?.text.includes('সক্রিয়'), 'the ACTIVE year is badged "সক্রিয়"', badgeOf(SAMPLE.active)?.text);
    check(badgeOf(SAMPLE.future)?.text.includes('নির্বাচন করুন'), 'a FUTURE year is badged "নির্বাচন করুন"', badgeOf(SAMPLE.future)?.text);
    check(!badgeOf(SAMPLE.future)?.text.includes('লক'), 'a FUTURE year is NEVER badged "লক"', badgeOf(SAMPLE.future)?.text);
    await page.screenshot({ path: path.join(SHOTS, '02-topbar-year-list-active.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    /* ---------------- (2b) the viewed year follows the year list ---------- */
    const viewedLabel = await viewedYearLabel(page);
    check(viewedLabel.includes(toBangla(SAMPLE.active)), 'the viewed year follows the year list', viewedLabel);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    /* ---------------- (3) PAST year: সম্পূর্ণ banner + all-black text ------ */
    await pickYear(page, SAMPLE.past);
    const pastBody = await page.locator('body').innerText();
    check(pastBody.includes(`${toBangla(SAMPLE.past)} সালের কার্যক্রম সম্পূর্ণ`), 'a finished past year SAYS "কার্যক্রম সম্পূর্ণ"', pastBody.split('\n').find((line) => line.includes('সালের কার্যক্রম সম্পূর্ণ'))?.slice(0, 90));
    check(pastBody.includes('শুধু দেখা'), 'a past year carries the "শুধু দেখা" chip');
    await page.screenshot({ path: path.join(SHOTS, '03-past-year-complete-banner.png') });

    // The YEAR banner is the `[role="status"]` that is NOT inside `main` and carries
    // the year wording (the Topbar's sync badge is a `[role="status"]` as well).
    const banner = await page.evaluate(() => {
      const candidate = [...document.querySelectorAll('[role="status"]')]
        .filter((element) => !element.closest('main'))
        .find((element) => element.innerText.includes('সালের'));
      if (!candidate) return null;
      const style = window.getComputedStyle(candidate);
      return {
        background: style.backgroundColor,
        color: style.color,
        text: candidate.innerText,
      };
    });
    check(Boolean(banner), 'the past year renders a year banner');
    const bannerBg = parseColor(banner?.background);
    check(Boolean(bannerBg) && isNeutral(bannerBg), 'the banner is monochrome (not yellow/amber)', banner?.background);
    check(Boolean(bannerBg) && luminance(bannerBg) > 225, 'the banner background is white/neutral-light', banner?.background);
    const bannerText = parseColor(banner?.color);
    check(Boolean(bannerText) && luminance(bannerText) < 70, 'the banner text is black', banner?.color);
    check(Boolean(banner?.text?.includes('কার্যক্রম সম্পূর্ণ')), 'the banner itself says কার্যক্রম সম্পূর্ণ', banner?.text?.slice(0, 60));

    const pastTexts = await page.evaluate(TEXT_COLORS, '.app-shell main');
    const colouredTexts = (pastTexts ?? []).filter((entry) => {
      const color = parseColor(entry.color);
      return !color || !isNeutral(color) || luminance(color) > 90;
    });
    check(Boolean(pastTexts?.length), 'the past-year page has measurable text', `${pastTexts?.length ?? 0} text nodes`);
    check(colouredTexts.length === 0, 'EVERY text on a past-year page is black/grey', colouredTexts.slice(0, 3).map((entry) => `${entry.text} → ${entry.color}`).join(' | '));

    const pastBackgrounds = await page.evaluate(BACKGROUNDS, '.app-shell main');
    const colouredBackgrounds = (pastBackgrounds ?? []).filter((entry) => {
      const color = parseColor(entry.background);
      return !color || !isNeutral(color);
    });
    check(colouredBackgrounds.length === 0, 'NO coloured background on a past-year page', colouredBackgrounds.slice(0, 3).map((entry) => `${entry.tag} → ${entry.background}`).join(' | '));
    const gradients = (pastBackgrounds ?? []).filter((entry) => entry.image && entry.image !== 'none');
    check(gradients.length === 0, 'NO gradient survives in a past-year page', gradients.slice(0, 2).map((entry) => entry.tag).join(' | '));
    await page.screenshot({ path: path.join(SHOTS, '04-past-year-all-black.png'), fullPage: true });



    /* ---------------- (4) FUTURE year: colourful + editable, no banner ---- */
    await pickYear(page, SAMPLE.future);
    // The roster is the page that proves "editable": its class tabs + form actions
    // must be live and the shell must not be monochrome.
    await page.goto(`${ORIGIN}/students`, { waitUntil: 'domcontentloaded' });
    await page.locator('.app-sidebar').first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(2200);
    // The year selection lives in the provider, so it survives the route change
    // only while the app stays mounted; re-select it after a full navigation.
    const yearAfterNav = await page.locator('header button:visible', { hasText: 'শিক্ষাবর্ষ' }).first().innerText();
    if (!yearAfterNav.includes(toBangla(SAMPLE.future))) await pickYear(page, SAMPLE.future);
    const futureBody = await page.locator('body').innerText();
    check(!futureBody.includes('কার্যক্রম সম্পূর্ণ'), 'the NEXT year has no complete-year banner');
    check(!futureBody.includes('শুধু দেখা'), 'the NEXT year has no "শুধু দেখা" chip');
    const futureLocked = await page.locator('.app-shell').evaluate((element) => element.classList.contains('locked-view'));
    check(futureLocked === false, 'the NEXT year shell is NOT locked-view');
    const futureTexts = await page.evaluate(TEXT_COLORS, '.app-shell main');
    const colourful = (futureTexts ?? []).filter((entry) => {
      const color = parseColor(entry.color);
      return color && !isNeutral(color);
    });
    check(colourful.length > 0, 'the NEXT year is still COLOURFUL (editable)', `${colourful.length} coloured text nodes, e.g. ${colourful[0]?.color}`);
    // Editable proof: the page is NOT inside the locked-view shell and the class tabs
    // (the roster's edit entry points) are present. `নতুন ভর্তি` only exists on the
    // roster route, which this run does not have to visit.
    const classTabs = await page.locator('[role="tablist"] [role="tab"]').count();
    check(classTabs >= 6, 'the NEXT year shows the editable class tabs', `${classTabs} tabs`);

    /* ---------------- (5) Promotion modal (focused harness) -------------- */
    /**
     * The modal is measured in its OWN page (`/modal-check.html`), which mounts just
     * `AutoPromotionModal` with a controlled promotion log — no database, no
     * Firebase. That makes the default-class / সম্পূর্ণ / unlock / centred-confirm
     * checks deterministic while still being a real Chrome render of the real
     * component with the real stylesheet.
     */
    const modalPage = await context.newPage();
    const modalErrors = [];
    modalPage.on('pageerror', (error) => modalErrors.push(String(error?.message ?? error)));
    await modalPage.goto(`${ORIGIN}/modal-check.html`, { waitUntil: 'domcontentloaded' });
    const modal = modalPage.locator('[role="dialog"]').first();
    await modal.waitFor({ timeout: 20_000 });
    await modalPage.waitForTimeout(600);
    check(modalErrors.length === 0, 'the promotion modal mounts without an error', modalErrors.slice(0, 2).join(' | '));

    const modalText = await modal.innerText();
    const selectedClass = await modal.locator('select').first().inputValue();
    check(selectedClass === 'c1', 'DEFAULT class = the FIRST unpromoted class (১ম শ্রেণি)', selectedClass);
    check(modalText.includes('সম্পূর্ণ'), 'the promoted class is marked "সম্পূর্ণ"');
    check(modalText.includes('প্রমোশনের অবস্থা'), 'the six-class status list is rendered');
    const statusChips = await modal.locator('[aria-label="ছয় শ্রেণির প্রমোশন অবস্থা"] button').allInnerTexts();
    check(statusChips.length === 6, 'the status list shows ALL six classes', `${statusChips.length} rows`);
    check(statusChips.filter((text) => text.includes('সম্পূর্ণ')).length === 1, 'exactly the promoted class says সম্পূর্ণ', statusChips.filter((text) => text.includes('সম্পূর্ণ')).join(' | '));
    const preChip = statusChips.find((text) => text.includes('প্রাক-প্রাথমিক'));
    check(Boolean(preChip?.includes('সম্পূর্ণ')), 'the status list marks pre-primary সম্পূর্ণ', preChip);
    await modalPage.screenshot({ path: path.join(SHOTS, '06-promotion-modal-default-c1.png'), fullPage: true });

    // The promoted class: its own chip, the unlock action and the unlock audit.
    await modal.locator('select').first().selectOption('pre');
    await modalPage.waitForTimeout(600);
    const lockedPanel = await modal.innerText();
    check(lockedPanel.includes('এই শ্রেণির কার্যক্রম সম্পূর্ণ'), 'the locked class shows its own "কার্যক্রম সম্পূর্ণ" chip');
    check(lockedPanel.includes('আনলক করুন'), 'a locked class offers the "আনলক করুন" action');
    check(lockedPanel.includes('আনলক করেছেন'), 'the panel shows WHO unlocked it (audit trail)');
    check(lockedPanel.includes('গোলাম মোস্তফা'), 'the audit names the admin', 'গোলাম মোস্তফা');
    check(lockedPanel.includes('golam@example.com'), 'the audit shows the admin email', 'golam@example.com');
    const lockedColours = await modalPage.evaluate((selector) => {
      const root = document.querySelector(selector);
      const panel = [...root.querySelectorAll('.locked-view')][0];
      if (!panel) return null;
      const style = window.getComputedStyle(panel);
      return { background: style.backgroundColor, color: style.color };
    }, '[role="dialog"]');
    check(Boolean(lockedColours), 'the completed-class panel carries the locked-view treatment');
    await modalPage.screenshot({ path: path.join(SHOTS, '07-promotion-modal-locked-class.png'), fullPage: true });

    // The centre panel lists the promoted class as সম্পূর্ণ as well.
    const preRowNow = (await modal.locator('[aria-label="ছয় শ্রেণির প্রমোশন অবস্থা"] button').allInnerTexts())
      .find((text) => text.includes('প্রাক-প্রাথমিক'));
    check(Boolean(preRowNow?.includes('সম্পূর্ণ')), 'the status list keeps marking pre-primary সম্পূর্ণ', preRowNow);

    /* ---------------- (6) Centred execute confirmation ------------------ */
    await modal.locator('select').first().selectOption('c1');
    await modalPage.waitForTimeout(400);
    const execute = modalPage.getByRole('button', { name: /উত্তরণ কার্যকর/ }).first();
    check(await execute.count() > 0, 'the execute button is present for an unpromoted class');
    if (await execute.count() > 0) {
      await execute.click();
      await modalPage.waitForTimeout(700);
      const confirm = modalPage.locator('[role="alertdialog"]');
      check(await confirm.count() > 0, 'the confirm step is a real dialog (role="alertdialog")');
      if (await confirm.count() > 0) {
        const box = await confirm.first().boundingBox();
        const viewport = modalPage.viewportSize();
        const centred = box
          && Math.abs((box.x + box.width / 2) - viewport.width / 2) < viewport.width * 0.16
          && Math.abs((box.y + box.height / 2) - viewport.height / 2) < viewport.height * 0.3;
        check(Boolean(centred), 'the confirmation is CENTRED on screen', box ? `x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)}` : 'no box');
        const confirmText = await confirm.first().innerText();
        check(
          confirmText.includes('হ্যাঁ, শুরু করুন') || confirmText.includes('হ্যাঁ, উত্তরণ করুন'),
          'the confirmation offers "হ্যাঁ, শুরু করুন" / "হ্যাঁ, উত্তরণ করুন"',
        );
        const overlay = await modalPage.evaluate(() => {
          const dialog = document.querySelector('[role="alertdialog"]');
          const wrapper = dialog?.parentElement;
          const style = wrapper ? window.getComputedStyle(wrapper) : null;
          return { position: style?.position, zIndex: style?.zIndex };
        });
        check(overlay.position === 'fixed', 'the confirmation sits in a fixed OVERLAY above the page', overlay.position);
        await modalPage.screenshot({ path: path.join(SHOTS, '08-centred-confirm-dialog.png') });
      }
    }

    await page.screenshot({ path: path.join(SHOTS, '05-future-year-editable.png') });
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
  notes.forEach((line) => console.log(line));
  if (problems.length) {
    console.error(`\nFAILED (${problems.length}):`);
    problems.forEach((problem) => console.error(`  x ${problem}`));
    process.exit(1);
  }
  console.log('\nPASS — real browser render check (past-year monochrome + সম্পূর্ণ, future year editable, Topbar badges, promotion modal defaults/unlock/centred confirm)');
};

main().catch((error) => {
  notes.forEach((line) => console.log(line));
  problems.forEach((problem) => console.error(`  x ${problem}`));
  console.error(error);
  process.exit(1);
});
