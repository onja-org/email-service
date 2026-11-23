/**
 * Renders the social share images (public/og/*.png, 1200x630) and the PNG brand
 * icons (public/brand/*.png) with headless Chrome, in the real brand fonts.
 *
 *   npm run og:images          (needs google-chrome or chromium on PATH, or CHROME=/path)
 *
 * Re-run after changing a page title, the logo or the fonts, and commit the PNGs.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pub = (...p: string[]) => path.join(root, 'public', ...p);
const font = (f: string) => pathToFileURL(pub('fonts', f)).href;
const host = new URL(process.env.PUBLIC_URL ?? 'https://email-sending-service.onja.dev').host;

const chrome =
  process.env.CHROME ??
  ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find((c) => {
    try {
      execFileSync('which', [c], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
if (!chrome) throw new Error('No Chrome/Chromium found; set CHROME=/path/to/chrome');

const CARDS: { id: string; kicker: string; title: string; sub: string }[] = [
  { id: 'home', kicker: 'Transactional email API', title: 'Email that <em>lands.</em>', sub: 'One API call from your app. Retries, tracking and deliverability handled.' },
  { id: 'how-it-works', kicker: 'How it works', title: 'Send email from your app <em>in three steps.</em>', sub: 'Get a key · verify your domain · POST /v1/emails' },
  { id: 'features', kicker: "What's included", title: 'Every email API feature, <em>already done.</em>', sub: 'Templates · attachments · tracking · a 90-day email log' },
  { id: 'reliability', kicker: 'Reliability', title: "A password reset <em>can't afford</em> to get lost.", sub: 'Queued before we reply · retried with backoff · never sent twice' },
  { id: 'faq', kicker: 'FAQ', title: 'The questions developers <em>ask first.</em>', sub: 'Own domain · SDKs · timeouts · attachments · limits' },
  { id: 'docs', kicker: 'Developer guide', title: 'Send email from Node.js, Python <em>&amp; Go.</em>', sub: 'Copy-paste clients · every endpoint · every error code' },
];

const pigeon = readFileSync(pub('brand', 'favicon.svg'), 'utf8')
  .replace(/<rect[^>]*\/>/, '')
  .replace('fill="#fbf7ee"', 'fill="#1c1a16"')
  .replace('fill="#c8361d"/></svg>', 'fill="#fbf7ee"/></svg>');

// The site's own brand symbols (pigeon, stamp, postmark), so the cards match the pages exactly.
const sprite = readFileSync(pub('site', 'layout.html'), 'utf8').match(/<svg width="0" height="0"[\s\S]*?<\/svg>/)![0];

const css = `
:root { --sheet: #fbf7ee; --post: #c8361d; --neck: #1d7559; --neck-2: #5d4a8c; }
@font-face { font-family: Fraunces; src: url(${font('fraunces.woff2')}); font-weight: 100 900; }
@font-face { font-family: Fraunces; src: url(${font('fraunces-italic.woff2')}); font-weight: 100 900; font-style: italic; }
@font-face { font-family: "Instrument Sans"; src: url(${font('instrument-sans.woff2')}); font-weight: 400 700; }
@font-face { font-family: "IBM Plex Mono"; src: url(${font('plex-mono-500.woff2')}); font-weight: 500; }
* { box-sizing: border-box; margin: 0; }
html, body { width: 1200px; height: 630px; overflow: hidden; background: #f3ede0; }
.card { position: absolute; inset: 0; border: 22px solid transparent;
  border-image: repeating-linear-gradient(-45deg, #c8361d 0 22px, #fbf7ee 22px 34px, #23408e 34px 56px, #fbf7ee 56px 68px) 22;
  background: #fbf7ee; padding: 58px 66px; display: flex; flex-direction: column; }
.kicker { font: 500 22px/1 "IBM Plex Mono"; letter-spacing: .14em; text-transform: uppercase; color: #4b463c; display: flex; align-items: center; gap: 16px; }
.kicker::before { content: ""; width: 40px; height: 3px; background: #c8361d; }
h1 { font-family: Fraunces; font-weight: 560; font-size: 74px; line-height: 1; letter-spacing: -0.035em; color: #1c1a16; margin-top: 30px; max-width: 670px;
  font-variation-settings: "SOFT" 30, "opsz" 144; }
h1 em { font-style: italic; font-weight: 500; color: #a92c17; font-variation-settings: "SOFT" 100, "WONK" 1, "opsz" 144; }
.sub { font: 400 26px/1.35 "Instrument Sans"; color: #4b463c; margin-top: 24px; max-width: 680px; }
.foot { margin-top: auto; display: flex; align-items: center; gap: 14px; }
.foot svg { width: 58px; height: 58px; }
.foot b { font-family: Fraunces; font-weight: 600; font-size: 40px; letter-spacing: -0.02em; color: #1c1a16; font-variation-settings: "SOFT" 100, "WONK" 1, "opsz" 48; }
.foot span { margin-left: auto; font: 500 20px/1 "IBM Plex Mono"; color: #6f685a; letter-spacing: .04em; }
.stamp { position: absolute; top: 40px; right: 50px; width: 164px; height: 196px; transform: rotate(2deg); }
.pm { position: absolute; top: 70px; right: 140px; width: 270px; height: 180px; color: #c8361d; opacity: .85; transform: rotate(-10deg); mix-blend-mode: multiply; }
`;

const out = mkdtempSync(path.join(tmpdir(), 'pigeon-og-'));
const profile = mkdtempSync(path.join(tmpdir(), 'pigeon-chrome-'));
function shoot(htmlFile: string, png: string, w: number, h: number) {
  execFileSync(chrome!, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--force-device-scale-factor=1', `--window-size=${w},${h}`, '--virtual-time-budget=4000',
    '--allow-file-access-from-files', `--screenshot=${png}`, pathToFileURL(htmlFile).href,
  ], { stdio: 'ignore' });
  if (!existsSync(png)) throw new Error(`Chrome did not write ${png}`);
  console.log('wrote', path.relative(root, png));
}

try {
  for (const c of CARDS) {
    const f = path.join(out, `${c.id}.html`);
    writeFileSync(f, `<!doctype html><meta charset="utf-8"><style>${css}</style>${sprite}<div class="card">
      <div class="kicker">${c.kicker}</div>
      <h1>${c.title}</h1>
      <p class="sub">${c.sub}</p>
      <div class="foot">${pigeon}<b>Pigeon</b><span>${host}</span></div>
      <svg class="stamp"><use href="#stamp"/></svg>
      <svg class="pm"><use href="#postmark"/></svg>
    </div>`);
    shoot(f, pub('og', `${c.id}.png`), 1200, 630);
  }
  const icon = readFileSync(pub('brand', 'favicon.svg'), 'utf8');
  for (const [name, size] of [['logo-512.png', 512], ['icon-96.png', 96], ['apple-touch-icon.png', 180]] as const) {
    const f = path.join(out, `${name}.html`);
    // Apple touch icons get square corners (iOS rounds them itself).
    const svg = name === 'apple-touch-icon.png' ? icon.replace('rx="14"', 'rx="0"') : icon;
    writeFileSync(f, `<!doctype html><style>html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
    shoot(f, pub('brand', name), size, size);
  }
} finally {
  rmSync(out, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}
