/**
 * URL allow-list at the INGEST boundary (§2 step 5 / N7).
 *
 * Reuses the exact same `safeUrl()` used at the render site so an unsafe URL is
 * rejected where it enters the system, not just where it is displayed. Only
 * absolute http(s) URLs survive; `javascript:` / `data:` / `vbscript:` /
 * control-character-obfuscated schemes yield null and are dropped + recorded.
 */
import { safeUrl } from '$lib/safe-url';
import type { LinkInput } from './types';

export { safeUrl };

/** Returns the URL when safe, else null. */
export function allowUrl(url: string | null | undefined): string | null {
	return safeUrl(url);
}

export interface PartitionedLinks {
	safe: Array<{ type: string; url: string; label: string | null }>;
	unsafe: Array<{ type: string; url: string; label: string | null }>;
}

/** Split incoming links into safe (sanitized url) and unsafe (rejected). */
export function partitionLinks(links: LinkInput[] | undefined): PartitionedLinks {
	const safe: PartitionedLinks['safe'] = [];
	const unsafe: PartitionedLinks['unsafe'] = [];
	for (const l of links ?? []) {
		const type = (l.type ?? 'website').trim() || 'website';
		const label = l.label?.trim() ? l.label.trim() : null;
		const clean = safeUrl(l.url);
		if (clean) safe.push({ type, url: clean, label });
		else unsafe.push({ type, url: String(l.url ?? ''), label });
	}
	return { safe, unsafe };
}
