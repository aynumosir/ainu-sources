/**
 * Does a slug carry anything that identifies the work?
 *
 * `slugify` skips kanji spans, since kanji has no deterministic reading. A
 * Japanese title therefore reduces to whatever kana and digits it happens to
 * contain, and those leftovers are usually the category word and a particle:
 * 「アイヌ語入門 : 改訂版 練習編14」 becomes `ainu-14`, 「様似のアイヌ語語彙集」
 * becomes `noainu`. Both look like slugs and identify nothing.
 *
 * Length cannot tell the difference — `ainu14` is six characters. What
 * distinguishes a real slug is at least one word that is not the subject of
 * the whole catalogue, not a particle, and not a hash.
 */

/** Words that every record could carry, so none of them identifies one. */
export const SLUG_STOPWORDS: ReadonlySet<string> = new Set([
	// the catalogue's own subject
	'ainu',
	'aynu',
	'ezo',
	// Japanese particles and copula fragments that survive romanization
	'no',
	'to',
	'ni',
	'wa',
	'ga',
	'de',
	'na',
	'nu',
	'ka',
	'su',
	'ku',
	'ri',
	'ci',
	'gu',
	'wo',
	// placeholders the minting paths fall back to
	'source',
	'cand',
	'unknown',
	'untitled',
	'x'
]);

const YEAR = /^(?:1\d{3}|20\d{2}|xxxx)$/;
const WORD = /^[a-z]{3,}$/;

/**
 * True when at least one segment names something. A leading year is ignored:
 * it dates the work without saying what it is.
 *
 * Segments carrying digits (`14`, `5f075bb5`, `142hdqp`) never count — a
 * number distinguishes one record from another only once something has already
 * identified the work.
 */
/**
 * Words naming the catalogue's own subject. A token built only from stopwords
 * is suspect only when one of these is in it.
 */
const SUBJECT_WORDS = ['ainu', 'aynu', 'ezo', 'source', 'unknown', 'untitled'];

/**
 * Stopwords survive romanization without the hyphen that separated them:
 * 「様似のアイヌ語語彙集」 leaves `noainu`, one token made of の + アイヌ.
 *
 * Decomposition alone is too blunt a test — Japanese surnames are built from
 * the same syllables, and `nakagawa` splits cleanly into na+ka+ga+wa. So a
 * token counts as a stopword compound only when it decomposes AND one of the
 * pieces is the subject of the catalogue itself. That admits `noainu` and
 * leaves Nakagawa, Wakana and their like alone.
 */
function isStopwordCompound(token: string): boolean {
	if (!SUBJECT_WORDS.some((w) => token.includes(w))) return false;
	const n = token.length;
	// reachable[i] — the first i characters are covered by stopwords
	const reachable = new Array<boolean>(n + 1).fill(false);
	reachable[0] = true;
	for (let i = 0; i < n; i++) {
		if (!reachable[i]) continue;
		for (const w of SLUG_STOPWORDS) {
			if (w.length && token.startsWith(w, i)) reachable[i + w.length] = true;
		}
	}
	return reachable[n];
}

export function slugHasContent(slug: string): boolean {
	const parts = slug.split('-').filter(Boolean);
	if (parts.length === 0) return false;
	const rest = YEAR.test(parts[0]) ? parts.slice(1) : parts;
	return rest.some((t) => WORD.test(t) && !SLUG_STOPWORDS.has(t) && !isStopwordCompound(t));
}

/**
 * Why a slug is unusable, or null when it is fine. Complements the shape and
 * collision checks in `explicitSlugError`, which a meaningless-but-well-formed
 * slug passes.
 */
export function slugContentError(slug: string): string | null {
	if (slugHasContent(slug)) return null;
	return (
		`slug "${slug}" names nothing: it needs at least one word of three or more ` +
		`letters that is not a year, a number, or one of ${[...SLUG_STOPWORDS].slice(0, 4).join(', ')}, …`
	);
}
