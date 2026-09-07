import settings from '../../project.inlang/settings.json';

export const baseLocale = settings.baseLocale;
export const locales = settings.locales;

export function getLocale(): string {
	return baseLocale;
}

export function deLocalizeUrl(input: URL): URL {
	const url = new URL(input);
	const [first, ...rest] = url.pathname.split('/').filter(Boolean);
	if (first && first !== baseLocale && locales.includes(first)) {
		url.pathname = `/${rest.join('/')}`;
	}
	return url;
}

export function localizeUrl(input: URL, options?: { locale?: string }): URL {
	const url = deLocalizeUrl(input);
	const locale = options?.locale ?? getLocale();
	if (locale !== baseLocale) {
		url.pathname = `/${locale}${url.pathname === '/' ? '/' : url.pathname}`;
	}
	return url;
}
