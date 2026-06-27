/**
 * Allow-list a URL for use as an `href`.
 *
 * Returns the URL only when it parses as an absolute `http:`/`https:` URL.
 * Everything else — `javascript:`, `data:`, `vbscript:`, `mailto:`, relative
 * or malformed input, and control-character obfuscation such as
 * `java\tscript:` — yields `null`, so callers can drop the attribute instead of
 * rendering a clickable XSS vector. Used at link render sites because the merge
 * engine ingests harvested / LLM-supplied URLs.
 */
export function safeUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	// Browsers ignore ASCII control chars (incl. TAB/LF/CR) inside a scheme, so
	// strip them — and surrounding whitespace — before validating the scheme.
	const cleaned = url.replace(/[\u0000-\u001f]/g, '').trim();
	if (!cleaned) return null;
	let parsed: URL;
	try {
		parsed = new URL(cleaned);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
	return cleaned;
}
