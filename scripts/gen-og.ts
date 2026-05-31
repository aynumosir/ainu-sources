/**
 * Generate static social/brand assets from the in-app brand mark.
 *
 *   bun scripts/gen-og.ts
 *
 * Produces (in static/):
 *   og.png               1200×630  Open Graph / Twitter card
 *   icon-512.png         512×512   PWA icon / schema.org Organization logo
 *   icon-192.png         192×192   PWA icon
 *   apple-touch-icon.png 180×180   iOS home-screen icon
 *   favicon.svg                    rounded tab icon (copy of the app mark)
 *
 * Requires `sharp` (present via the dependency tree). Re-run after brand changes.
 */
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const STATIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'static');

const BRAND = '#843123';
const BRAND_DEEP = '#7c2d1e';
const CREAM = '#f4ecd9';
const PAPER = '#f3ead6';
const STONE = '#57534e';

/** The open-book glyph, drawn in a 64×64 box (matches src/lib/assets/favicon.svg). */
const bookGlyph = (bg: 'round' | 'full' | 'none') => `
  ${bg === 'round' ? `<rect width="64" height="64" rx="14" fill="${BRAND}" />` : ''}
  ${bg === 'full' ? `<rect width="64" height="64" fill="${BRAND}" />` : ''}
  <g fill="${CREAM}">
    <path d="M32 19c-5-3-12.5-3.6-17.5-2.3a1.6 1.6 0 0 0-1.2 1.6v26.5c0 1 .9 1.7 1.9 1.5C20 45.2 27 45.7 32 48.4Z" />
    <path d="M32 19c5-3 12.5-3.6 17.5-2.3a1.6 1.6 0 0 1 1.2 1.6v26.5c0 1-.9 1.7-1.9 1.5C44 45.2 37 45.7 32 48.4Z" />
  </g>
  <g stroke="${BRAND}" stroke-width="1.7" stroke-linecap="round" opacity="0.45">
    <line x1="20" y1="25" x2="28.5" y2="26.4" /><line x1="20" y1="31" x2="28.5" y2="32.4" />
    <line x1="20" y1="37" x2="28.5" y2="38.4" /><line x1="35.5" y1="26.4" x2="44" y2="25" />
    <line x1="35.5" y1="32.4" x2="44" y2="31" /><line x1="35.5" y1="38.4" x2="44" y2="37" />
  </g>
  <line x1="32" y1="19" x2="32" y2="48.4" stroke="${BRAND}" stroke-width="1.4" opacity="0.4" />`;

const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Ainu Textual Sources">${bookGlyph(
	'round'
)}</svg>`;

// Full-bleed square icon (OS rounds/masks it); glyph sits in the maskable safe zone.
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${bookGlyph('full')}</svg>`;

// 1200×630 Open Graph card.
const ogSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${PAPER}" />
  <rect x="24" y="24" width="1152" height="582" rx="28" fill="none" stroke="${BRAND}" stroke-width="3" opacity="0.22" />
  <svg x="96" y="104" width="148" height="148" viewBox="0 0 64 64">${bookGlyph('round')}</svg>
  <text x="264" y="205" font-family="Noto Sans, DejaVu Sans, sans-serif" font-size="30" font-weight="600" letter-spacing="2" fill="${BRAND}" opacity="0.85">db.aynu.org</text>
  <text x="96" y="360" font-family="Noto Serif, DejaVu Serif, serif" font-size="86" font-weight="700" fill="${BRAND_DEEP}">Ainu Textual Sources</text>
  <text x="96" y="452" font-family="Noto Serif, DejaVu Serif, serif" font-size="86" font-weight="700" fill="${BRAND_DEEP}">Database</text>
  <text x="100" y="528" font-family="Noto Sans, DejaVu Sans, sans-serif" font-size="32" font-weight="400" fill="${STONE}">An open philological knowledge base for Ainu-language sources.</text>
</svg>`;

async function png(svg: string, size: { width?: number; height?: number }, out: string) {
	await sharp(Buffer.from(svg), { density: 384 })
		.resize(size)
		.png({ compressionLevel: 9 })
		.toFile(join(STATIC, out));
	console.log('✓', out);
}

writeFileSync(join(STATIC, 'favicon.svg'), faviconSvg + '\n');
console.log('✓ favicon.svg');
await png(ogSvg, { width: 1200, height: 630 }, 'og.png');
await png(iconSvg, { width: 512, height: 512 }, 'icon-512.png');
await png(iconSvg, { width: 192, height: 192 }, 'icon-192.png');
await png(iconSvg, { width: 180, height: 180 }, 'apple-touch-icon.png');
console.log('done');
