import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const component = readFileSync(fileURLToPath(new URL('./routes/+error.svelte', import.meta.url)), 'utf8');
const fallback = readFileSync(fileURLToPath(new URL('./error.html', import.meta.url)), 'utf8');

function luminance(hex: string): number {
	const channels = hex
		.slice(1)
		.match(/.{2}/g)!
		.map((channel) => Number.parseInt(channel, 16) / 255)
		.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
	return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a: string, b: string): number {
	const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (lighter + 0.05) / (darker + 0.05);
}

function renderFallback(pathname: string) {
	const script = fallback.match(/<script>([\s\S]*?)<\/script>/)?.[1];
	if (!script) throw new Error('Fallback localization script is missing');
	const elements = {
		content: { lang: '' },
		status: { textContent: '500' },
		title: { textContent: '' },
		body: { textContent: '' },
		home: { textContent: '', href: '' }
	};
	const document = {
		documentElement: { lang: 'en' },
		title: '',
		getElementById(id: keyof typeof elements) {
			return elements[id];
		}
	};
	runInNewContext(script, { document, location: { pathname } });
	return { document, elements };
}

describe('error pages', () => {
	it('keeps backend error messages out of the rendered component', () => {
		expect(component).not.toContain('page.error');
		expect(component).toContain('content="noindex, follow"');
	});

	it('selects dedicated public copy for authorization failures', () => {
		for (const status of [401, 403, 404]) {
			expect(component).toContain(`case ${status}:`);
			expect(component).toContain(`m.error_${status}_title()`);
			expect(component).toContain(`m.error_${status}_body()`);
		}
	});

	it('provides a safe static fallback for fatal rendering errors', () => {
		const html = fallback.replaceAll('%sveltekit.status%', '500');
		expect(html).toContain('<meta name="robots" content="noindex, follow" />');
		expect(html).toContain('<title>500 · Page unavailable · Ainu Sources</title>');
		expect(html).toContain('<h1 id="title">Page unavailable</h1>');
		expect(fallback).not.toContain('%sveltekit.error.message%');
		expect(html).not.toContain('database connection failed');
	});

	it.each([
		['/ja/missing', 'ja', 'ja', 'ページを表示できません', '/ja'],
		['/ru/missing', 'ru', 'ru', 'Страница недоступна', '/ru'],
		['/ain/missing', 'ain', 'en', 'Page unavailable', '/ain'],
		['/missing', 'en', 'en', 'Page unavailable', '/']
	])(
		'localizes a fatal fallback for %s',
		(pathname, documentLang, contentLang, title, home) => {
			const rendered = renderFallback(pathname);
			expect(rendered.document.documentElement.lang).toBe(documentLang);
			expect(rendered.elements.content.lang).toBe(contentLang);
			expect(rendered.elements.title.textContent).toBe(title);
			expect(rendered.elements.home.href).toBe(home);
			expect(rendered.document.title).toBe(`500 · ${title} · Ainu Sources`);
		}
	);

	it('uses AA-contrast text colors on the paper background', () => {
		expect(component).toContain('text-brand-600');
		expect(component).toContain('text-stone-700');
		expect(contrast('#9a3d2c', '#f4ecd9')).toBeGreaterThanOrEqual(3);
		expect(contrast('#44403c', '#f4ecd9')).toBeGreaterThanOrEqual(4.5);
		expect(contrast('#ffffff', '#843123')).toBeGreaterThanOrEqual(4.5);
	});
});
