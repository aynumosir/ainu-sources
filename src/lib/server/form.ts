import type { SourceInput } from './queries';

/** Parse a SourceForm submission into a validated SourceInput. */
export function parseSourceForm(fd: FormData): { input?: SourceInput; error?: string } {
	const str = (k: string) => {
		const v = fd.get(k);
		return typeof v === 'string' ? v.trim() : '';
	};
	const opt = (k: string) => str(k) || null;
	const numOpt = (k: string) => {
		const v = str(k);
		if (!v) return null;
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	};
	const list = (k: string) =>
		str(k)
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);

	const title = str('title');
	const category = str('category');
	const type = str('type');
	if (!title) return { error: 'Title is required.' };
	if (!category || !type) return { error: 'Category and type are required.' };

	let links: { type: string; label: string | null; url: string }[] = [];
	try {
		const parsed = JSON.parse(str('linksJson') || '[]');
		if (Array.isArray(parsed)) {
			links = parsed
				.filter((l) => l && typeof l.url === 'string' && l.url.trim())
				.map((l) => ({
					type: String(l.type || 'website'),
					label: l.label ? String(l.label) : null,
					url: String(l.url).trim()
				}));
		}
	} catch {
		/* ignore malformed links */
	}

	const input: SourceInput = {
		title,
		titleEn: opt('titleEn'),
		titleAin: opt('titleAin'),
		category,
		type,
		author: opt('author'),
		yearText: opt('yearText'),
		yearStart: numOpt('yearStart'),
		yearEnd: numOpt('yearEnd'),
		yearCertainty: opt('yearCertainty') || 'exact',
		dialect: opt('dialect'),
		region: opt('region'),
		languages: list('languages'),
		scripts: list('scripts'),
		holdingInstitution: opt('holdingInstitution'),
		callNumber: opt('callNumber'),
		entryCount: numOpt('entryCount'),
		entryCountLabel: opt('entryCountLabel'),
		license: opt('license'),
		summary: opt('summary'),
		notes: opt('notes'),
		reliability: opt('reliability'),
		links,
		tagNames: list('tags')
	};
	return { input };
}

export function revisionSummary(fd: FormData): string {
	const v = fd.get('revisionSummary');
	return typeof v === 'string' ? v.trim() : '';
}

/**
 * Guard against open redirects: only allow internal absolute paths.
 * Rejects protocol-relative URLs (`//host`, `/\host`) and any path containing
 * a backslash or ASCII control character, which browsers may treat as an
 * external destination.
 */
export function safePath(p: string | null | undefined, fallback = '/account'): string {
	if (!p) return fallback;
	if (p === '/') return p;
	if (!/^\/[^/\\]/.test(p)) return fallback; // must be "/" + a non-slash/backslash char
	if (p.includes('\\')) return fallback; // no backslashes
	for (let i = 0; i < p.length; i++) {
		if (p.charCodeAt(i) < 0x20) return fallback; // no control characters
	}
	return p;
}
