#!/usr/bin/env node
/**
 * Records the README screenshots and GIFs from demo mode (fake cluster, fictional data).
 *
 *   npm run media                       # build, then record everything into docs/media/
 *   node scripts/record-media.mjs logs  # record only scenes whose name contains "logs"
 *
 * Needs a Chromium for Playwright once: npx playwright install chromium
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gifencModule from 'gifenc';
import pngjs from 'pngjs';
import { chromium } from 'playwright';

// Both packages are CommonJS; take their exports from whichever shape Node gives us.
const { GIFEncoder, quantize, applyPalette } = gifencModule.default ?? gifencModule;
const { PNG } = pngjs;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'media');
const VIEWPORT = { width: 1280, height: 760 };
const FPS = 8;

process.env.KUBEDECK_DEMO = '1';
const { createApp } = await import('../dist/server/http.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- server --------------------------------------------------------------------

const TOKEN = 'readme-media';
const server = createApp(TOKEN);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}/?t=${TOKEN}#new`;

// ---- recording helpers ----------------------------------------------------------

/** A visible mouse pointer: headless screenshots do not include the OS cursor. */
const CURSOR_SCRIPT = `
  window.addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.id = '__cursor';
    c.style.cssText = 'position:fixed;z-index:99999;left:0;top:0;width:18px;height:18px;margin:-3px 0 0 -3px;pointer-events:none;transition:transform .08s';
    c.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 2l16 11-7 1.5L9.5 22z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
    addEventListener('mousedown', () => { c.style.transform = 'scale(.8)'; }, true);
    addEventListener('mouseup', () => { c.style.transform = ''; }, true);
  });
`;

async function newPage(browser) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: 'dark', locale: 'en-US' });
  await context.addInitScript(CURSOR_SCRIPT);
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForSelector('.tiles', { timeout: 15_000 });
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await sleep(800);
  return page;
}

async function moveTo(page, locator) {
  await locator.first().waitFor({ state: 'visible', timeout: 10_000 });
  const box = await locator.first().boundingBox();
  if (!box) throw new Error(`not visible: ${locator}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 14 });
  await sleep(250);
}

async function click(page, locator, modifiers = []) {
  await moveTo(page, locator);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.down();
  await page.mouse.up();
  for (const m of modifiers) await page.keyboard.up(m);
  await sleep(500);
}

async function type(page, text) {
  await page.keyboard.type(text, { delay: 110 });
  await sleep(400);
}

/** Takes screenshots while `steps` runs, then writes them as an animated GIF. */
async function recordGif(page, name, steps) {
  const frames = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const started = Date.now();
      frames.push({ png: await page.screenshot({ type: 'png' }), at: started });
      const wait = 1000 / FPS - (Date.now() - started);
      if (wait > 0) await sleep(wait);
    }
  })();
  await steps();
  running = false;
  await loop;
  writeGif(join(OUT, `${name}.gif`), frames);
}

function writeGif(file, frames) {
  const gif = GIFEncoder();
  let i = 0;
  while (i < frames.length) {
    // Merge identical consecutive frames into one longer frame.
    let j = i + 1;
    while (j < frames.length && frames[j].png.equals(frames[i].png)) j++;
    const end = j < frames.length ? frames[j].at : frames[j - 1].at + 1500;
    const { width, height, data } = PNG.sync.read(frames[i].png);
    const palette = quantize(data, 256);
    gif.writeFrame(applyPalette(data, palette), width, height, { palette, delay: Math.max(60, end - frames[i].at) });
    i = j;
  }
  gif.finish();
  writeFileSync(file, gif.bytes());
  console.log(`  wrote ${file.replace(ROOT, '.')} (${(gif.bytes().length / 1024 / 1024).toFixed(1)} MB, ${frames.length} frames)`);
}

// ---- scenes ---------------------------------------------------------------------

const scenes = {
  async dashboard(browser) {
    const page = await newPage(browser);
    await sleep(1500);
    await page.screenshot({ path: join(OUT, 'dashboard.png') });
    await recordGif(page, 'dashboard', async () => {
      await sleep(1200);
      await moveTo(page, page.locator('.tile').nth(1));
      await sleep(600);
      await moveTo(page, page.locator('.problem').first());
      await sleep(900);
      for (let k = 0; k < 6; k++) {
        await page.mouse.wheel(0, 140);
        await sleep(260);
      }
      await moveTo(page, page.locator('.bar-row').first());
      await sleep(1500);
      for (let k = 0; k < 6; k++) {
        await page.mouse.wheel(0, -140);
        await sleep(200);
      }
      await sleep(900);
    });
    await page.context().close();
  },

  async diagnosis(browser) {
    const page = await newPage(browser);
    await recordGif(page, 'diagnosis', async () => {
      await sleep(800);
      await click(page, page.locator('.problem', { hasText: 'api-7d9f8c6b5-m4zt8' }));
      await page.waitForSelector('.diag', { timeout: 10_000 });
      await sleep(2600);
      await moveTo(page, page.locator('.diag-evidence').first());
      await sleep(1600);
      await click(page, page.locator('.diag-actions button', { hasText: 'View previous logs' }).first());
      await sleep(3000);
    });
    await page.screenshot({ path: join(OUT, 'diagnosis.png') });
    await page.context().close();
  },

  async logs(browser) {
    const page = await newPage(browser);
    await recordGif(page, 'logs', async () => {
      await click(page, page.locator('.side-item', { hasText: 'Pods' }));
      await sleep(900);
      await click(page, page.locator('.search-box.grow input'));
      await type(page, 'api');
      await click(page, page.locator('tr', { hasText: 'api-7d9f8c6b5-x2kqp' }));
      await sleep(1200);
      await click(page, page.locator('.drawer .tab', { hasText: 'Logs' }));
      await sleep(3500);
      await click(page, page.locator('.logs-toolbar .chip', { hasText: 'Timestamps' }));
      await sleep(2000);
      await click(page, page.locator('.logs-toolbar .search-box input'));
      await type(page, 'error');
      await sleep(3000);
    });
    await page.context().close();
  },

  async tabs(browser) {
    const page = await newPage(browser);
    await recordGif(page, 'tabs-and-split', async () => {
      await click(page, page.locator('.side-item', { hasText: 'Pods' }));
      await sleep(900);
      await click(page, page.locator('tr', { hasText: 'api-7d9f8c6b5-x2kqp' }), ['Control']);
      await sleep(1500);
      await click(page, page.locator('.drawer-page .tab', { hasText: 'Logs' }));
      await sleep(1800);
      await click(page, page.locator('.tabbar-tools button', { hasText: 'Split' }).first());
      await sleep(1000);
      await page.keyboard.press(':');
      await sleep(400);
      await type(page, 'ks');
      await page.keyboard.press('Enter');
      await sleep(1200);
      await click(page, page.locator('.pane').nth(1).locator('tr', { hasText: 'monitoring' }));
      await sleep(3000);
    });
    await page.context().close();
  },

  async protect(browser) {
    const page = await newPage(browser);
    await recordGif(page, 'protected-context', async () => {
      await sleep(600);
      await page.keyboard.press(':');
      await sleep(400);
      await type(page, 'ctx prod');
      await page.keyboard.press('Enter');
      await sleep(1600);
      await click(page, page.locator('.side-item', { hasText: 'Deployments' }));
      await sleep(900);
      await click(page, page.locator('tr', { hasText: 'checkout' }));
      await sleep(1200);
      await click(page, page.locator('.drawer-actions button', { hasText: 'Restart' }));
      await sleep(1600);
      await type(page, 'checkout');
      await sleep(500);
      await click(page, page.locator('.modal-foot .btn-primary'));
      await sleep(2500);
    });
    await page.context().close();
  },

  async forward(browser) {
    const page = await newPage(browser);
    await recordGif(page, 'port-forward', async () => {
      await click(page, page.locator('.side-item', { hasText: 'Services' }));
      await sleep(900);
      await click(page, page.locator('tr', { hasText: /^\s*web/ }));
      await sleep(1000);
      await click(page, page.locator('.drawer-actions button', { hasText: 'Port-forward' }));
      await sleep(1200);
      await click(page, page.locator('.modal-foot .btn-primary'));
      await sleep(3000);
    });
    await page.context().close();
  },
};

// ---- main -----------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const only = process.argv[2];
let browser;
try {
  browser = await chromium.launch();
} catch (err) {
  console.error('Could not start Chromium. Install it once with:  npx playwright install chromium\n');
  console.error(String(err?.message ?? err));
  server.close();
  process.exit(1);
}

try {
  for (const [name, scene] of Object.entries(scenes)) {
    if (only && !name.includes(only)) continue;
    console.log(`scene: ${name}`);
    await scene(browser);
  }
} finally {
  await browser.close();
  server.close();
}
console.log('done');
