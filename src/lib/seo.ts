/**
 * SEO helpers — absolute/localized URLs, hreflang alternates, Open Graph locale
 * mapping, safe JSON-LD serialization, and schema.org builders for every entity.
 *
 * The site is multilingual (paraglide): `en` is the base locale and is served
 * unprefixed, while `ja` / `ru` / `ain` live under `/ja`, `/ru`, `/ain`. All
 * canonical + alternate URLs are derived from the locale-stripped ("bare") path
 * so they stay reciprocal across locales.
 */
import { localizeUrl, deLocalizeUrl, locales, baseLocale } from '$lib/paraglide/runtime';
import { tl, REGION_LABELS, type Locale } from '$lib/constants';
import { asArray, personFindLinks } from '$lib/format';
import type {
	Source,
	SourceLink,
	Person,
	Place,
	Institution,
	Tag
} from '$lib/server/db/schema';

// ---------------------------------------------------------------------------
// Site-wide constants
// ---------------------------------------------------------------------------

/** Canonical production origin (fallback when a request origin is unavailable). */
export const SITE_ORIGIN = 'https://db.aynu.org';
/** Source-of-record repository — used as Organization `sameAs`. */
export const REPO_URL = 'https://github.com/aynumosir/ainu-sources';

/** Default social-share image (1200×630). Served from `static/`. */
export const OG_IMAGE_PATH = '/og.png';
export const OG_IMAGE_W = 1200;
export const OG_IMAGE_H = 630;
/** Square brand mark used as the Organization logo / manifest icon. */
export const LOGO_PATH = '/icon-512.png';

/** og:locale uses the `language_TERRITORY` form. */
export const OG_LOCALE: Record<Locale, string> = {
	en: 'en_US',
	ja: 'ja_JP',
	ru: 'ru_RU',
	ain: 'ain_JP'
};

/** ISO 639-3 (as stored in the DB) → BCP-47 for schema.org `inLanguage`. */
const BCP47: Record<string, string> = {
	ain: 'ain',
	jpn: 'ja',
	rus: 'ru',
	eng: 'en',
	lat: 'la',
	zho: 'zh',
	kor: 'ko',
	deu: 'de',
	fra: 'fr',
	spa: 'es',
	ita: 'it',
	pol: 'pl',
	nld: 'nl'
};
const toBcp47 = (code: string): string => BCP47[code] ?? code;

// ---------------------------------------------------------------------------
// URL + hreflang helpers
// ---------------------------------------------------------------------------

/** Absolute, locale-localized URL for a bare (locale-stripped) path.
 *  When `locale` is omitted the ambient render locale is used (paraglide's
 *  `getLocale()`), so JSON-LD URLs emitted during SSR match the page's canonical.
 *  Trailing slashes are normalized away (except the site root) so canonical /
 *  hreflang / sitemap URLs match SvelteKit's no-trailing-slash routes — e.g. the
 *  localized home is `/ja`, not `/ja/` (which would 308-redirect). */
export function localizedAbs(origin: string, barePath: string, locale?: Locale): string {
	const u = locale
		? localizeUrl(new URL(barePath, origin), { locale })
		: localizeUrl(new URL(barePath, origin));
	if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
	return u.href;
}

/** Strip the locale prefix from a URL, yielding the canonical bare pathname. */
export function barePathOf(url: URL): string {
	return deLocalizeUrl(url).pathname;
}

export interface AlternateLink {
	hreflang: string;
	href: string;
}

/**
 * Reciprocal hreflang set for a bare path: one entry per locale plus an
 * `x-default` pointing at the base-locale (unprefixed) URL.
 */
export function hreflangAlternates(origin: string, barePath: string): AlternateLink[] {
	const out: AlternateLink[] = locales.map((l) => ({
		hreflang: l,
		href: localizedAbs(origin, barePath, l as Locale)
	}));
	out.push({ hreflang: 'x-default', href: localizedAbs(origin, barePath, baseLocale as Locale) });
	return out;
}

/** og:locale:alternate values (every locale except the current one). */
export function ogAlternateLocales(current: Locale): string[] {
	return (locales as readonly string[])
		.filter((l) => l !== current)
		.map((l) => OG_LOCALE[l as Locale]);
}

/** Determine the locale a URL renders as, purely from its path prefix. */
export function localeOfUrl(url: URL): Locale {
	const seg = url.pathname.split('/').filter(Boolean)[0];
	return seg && seg !== baseLocale && (locales as readonly string[]).includes(seg)
		? (seg as Locale)
		: (baseLocale as Locale);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Collapse whitespace and clamp to `max` chars at a sensible boundary. */
export function truncate(text: string | null | undefined, max = 160): string {
	if (!text) return '';
	const s = text.replace(/\s+/g, ' ').trim();
	if (s.length <= max) return s;
	const cut = s.slice(0, max - 1);
	// Prefer to break at the last word / CJK punctuation boundary.
	const at = Math.max(
		cut.lastIndexOf(' '),
		cut.lastIndexOf('、'),
		cut.lastIndexOf('。'),
		cut.lastIndexOf('，'),
		cut.lastIndexOf('—')
	);
	return (at >= max * 0.5 ? cut.slice(0, at) : cut).trim() + '…';
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Drop null / undefined / empty-string / empty-array members in place. */
function prune<T extends Json>(obj: T): T {
	for (const k of Object.keys(obj)) {
		const v = obj[k];
		if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) delete obj[k];
	}
	return obj;
}

/** Serialize a JSON-LD object for safe embedding inside a <script> tag. */
export function serializeJsonLd(data: unknown): string {
	return JSON.stringify(data)
		.replace(/</g, '\\u003c')
		.replace(/>/g, '\\u003e')
		.replace(/&/g, '\\u0026')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');
}

const dedupe = (xs: (string | null | undefined)[], not?: string): string[] =>
	[...new Set(xs.filter((x): x is string => !!x && x !== not))];

// --- global: WebSite + Organization -------------------------------------------------

export function websiteJsonLd(opts: {
	origin: string;
	name: string;
	description: string;
	inLanguage: string | string[];
}): Json {
	return {
		'@context': 'https://schema.org',
		'@type': 'WebSite',
		'@id': `${opts.origin}/#website`,
		url: `${opts.origin}/`,
		name: opts.name,
		description: opts.description,
		inLanguage: opts.inLanguage,
		publisher: { '@id': `${opts.origin}/#organization` },
		potentialAction: {
			'@type': 'SearchAction',
			target: {
				'@type': 'EntryPoint',
				urlTemplate: `${opts.origin}/sources?q={search_term_string}`
			},
			'query-input': 'required name=search_term_string'
		}
	};
}

export function organizationJsonLd(opts: {
	origin: string;
	name: string;
	description: string;
	sameAs?: string[];
}): Json {
	return prune({
		'@context': 'https://schema.org',
		'@type': 'Organization',
		'@id': `${opts.origin}/#organization`,
		name: opts.name,
		alternateName: 'Ainu Sources',
		url: `${opts.origin}/`,
		description: opts.description,
		logo: `${opts.origin}${LOGO_PATH}`,
		sameAs: opts.sameAs ?? [REPO_URL]
	});
}

// --- breadcrumbs --------------------------------------------------------------------

export function breadcrumbJsonLd(origin: string, items: { name: string; path: string }[]): Json {
	return {
		'@context': 'https://schema.org',
		'@type': 'BreadcrumbList',
		itemListElement: items.map((it, i) => ({
			'@type': 'ListItem',
			position: i + 1,
			name: it.name,
			item: localizedAbs(origin, it.path)
		}))
	};
}

// --- collection / web pages ---------------------------------------------------------

export function collectionPageJsonLd(opts: {
	origin: string;
	path: string;
	name: string;
	description: string;
	numberOfItems?: number;
}): Json {
	return prune({
		'@context': 'https://schema.org',
		'@type': 'CollectionPage',
		url: localizedAbs(opts.origin, opts.path),
		name: opts.name,
		description: opts.description,
		isPartOf: { '@id': `${opts.origin}/#website` },
		mainEntity:
			opts.numberOfItems != null
				? { '@type': 'ItemList', numberOfItems: opts.numberOfItems }
				: undefined
	});
}

// --- source detail ------------------------------------------------------------------

/** Map a fine source `type` onto a Google-recognized schema.org @type. */
function sourceSchemaType(type: string): string {
	switch (type) {
		case 'article':
			return 'ScholarlyArticle';
		case 'thesis':
			return 'Thesis';
		case 'grammar':
		case 'book':
		case 'dictionary':
		case 'topical-dictionary':
		case 'japanese-ainu-dictionary':
		case 'online-dictionary':
		case 'workbook':
		case 'glossary':
		case 'bibliography':
		case 'old-document':
			return 'Book';
		case 'corpus-text':
		case 'comparative-wordlist':
		case 'wordlist':
		case 'nouns':
		case 'verbs':
		case 'reference':
		case 'valency-dataset':
		case 'dataset':
			return 'Dataset';
		case 'software':
		case 'model':
			return 'SoftwareApplication';
		case 'web-article':
			return 'BlogPosting';
		case 'website':
			return 'WebSite';
		default:
			return 'CreativeWork';
	}
}

/** Link `type`s that unambiguously identify the same work → schema.org `sameAs`. */
const SAMEAS_LINK_TYPES = new Set(['wikidata', 'doi', 'wikipedia', 'ndl', 'cinii', 'iiif', 'opac']);

export function sourceJsonLd(
	detail: {
		source: Source;
		links: SourceLink[];
		persons: (Person & { role: string })[];
		places: (Place & { role: string })[];
		institutions: (Institution & { role: string })[];
		tags: Tag[];
	},
	origin: string
): Json {
	const s = detail.source;
	const url = localizedAbs(origin, `/sources/${s.slug}`);
	const authors = detail.persons
		.filter((p) => ['author', 'editor', 'compiler'].includes(p.role))
		.map((p) => prune({ '@type': 'Person', name: p.name, url: localizedAbs(origin, `/people/${p.slug}`) }));
	const publishers = detail.institutions
		.filter((i) => i.role === 'publisher')
		.map((i) => prune({ '@type': 'Organization', name: i.name, url: localizedAbs(origin, `/institutions/${i.slug}`) }));
	const spatial = detail.places.map((p) =>
		prune({
			'@type': 'Place',
			name: p.name,
			geo:
				p.lat != null && p.lng != null
					? { '@type': 'GeoCoordinates', latitude: p.lat, longitude: p.lng }
					: undefined
		})
	);
	const sameAs = dedupe(
		detail.links.filter((l) => SAMEAS_LINK_TYPES.has(l.type)).map((l) => l.url)
	);

	return prune({
		'@context': 'https://schema.org',
		'@type': sourceSchemaType(s.type),
		'@id': `${url}#record`,
		url,
		name: s.title,
		alternateName: dedupe([s.titleEn, s.titleAin, ...asArray(s.altTitles)], s.title),
		description: truncate(s.summary, 300) || undefined,
		inLanguage: asArray(s.languages).map(toBcp47),
		author: authors.length ? authors : s.author || undefined,
		datePublished: s.yearStart != null ? String(s.yearStart) : undefined,
		dateModified: s.updatedAt ? new Date(s.updatedAt).toISOString() : undefined,
		keywords: detail.tags.map((t) => t.name).join(', ') || undefined,
		about: dedupe([s.dialect, s.region ? tl(REGION_LABELS, s.region) : null]),
		contentLocation: spatial.length ? spatial : undefined,
		publisher: publishers.length ? publishers : undefined,
		license: s.license && /^https?:\/\//.test(s.license) ? s.license : undefined,
		sameAs: sameAs.length ? sameAs : undefined,
		isPartOf: { '@id': `${origin}/#website` }
	});
}

// --- person detail ------------------------------------------------------------------

export function personJsonLd(person: Person, origin: string): Json {
	const url = localizedAbs(origin, `/people/${person.slug}`);
	return prune({
		'@context': 'https://schema.org',
		'@type': 'Person',
		'@id': `${url}#person`,
		url,
		name: person.name,
		alternateName: dedupe([person.nameEn, person.nameKana, person.nameAin], person.name),
		birthDate: person.birthYear != null ? String(person.birthYear) : undefined,
		deathDate: person.deathYear != null ? String(person.deathYear) : undefined,
		description: truncate(person.bio, 300) || undefined,
		sameAs: dedupe(personFindLinks(person).filter((l) => l.verified).map((l) => l.url))
	});
}

// --- place detail -------------------------------------------------------------------

export function placeJsonLd(place: Place, origin: string): Json {
	const url = localizedAbs(origin, `/places/${place.slug}`);
	const sameAs = dedupe([
		place.geonames ? `https://www.geonames.org/${place.geonames}` : null,
		place.wikidata ? `https://www.wikidata.org/wiki/${place.wikidata}` : null
	]);
	return prune({
		'@context': 'https://schema.org',
		'@type': 'Place',
		'@id': `${url}#place`,
		url,
		name: place.name,
		alternateName: dedupe([place.nameEn, place.nameAin], place.name),
		geo:
			place.lat != null && place.lng != null
				? { '@type': 'GeoCoordinates', latitude: place.lat, longitude: place.lng }
				: undefined,
		containedInPlace: place.region
			? { '@type': 'AdministrativeArea', name: tl(REGION_LABELS, place.region) }
			: undefined,
		sameAs: sameAs.length ? sameAs : undefined
	});
}

// --- institution detail -------------------------------------------------------------

export function institutionJsonLd(institution: Institution, origin: string): Json {
	const pageUrl = localizedAbs(origin, `/institutions/${institution.slug}`);
	return prune({
		'@context': 'https://schema.org',
		'@type': 'Organization',
		'@id': `${pageUrl}#organization`,
		name: institution.name,
		alternateName: institution.nameEn && institution.nameEn !== institution.name ? institution.nameEn : undefined,
		url: institution.url || pageUrl,
		mainEntityOfPage: pageUrl,
		address:
			institution.city || institution.country
				? prune({
						'@type': 'PostalAddress',
						addressLocality: institution.city ?? undefined,
						addressCountry: institution.country ?? undefined
					})
				: undefined,
		geo:
			institution.lat != null && institution.lng != null
				? { '@type': 'GeoCoordinates', latitude: institution.lat, longitude: institution.lng }
				: undefined,
		sameAs: dedupe([
			institution.wikidata ? `https://www.wikidata.org/wiki/${institution.wikidata}` : null,
			institution.url || null
		])
	});
}
