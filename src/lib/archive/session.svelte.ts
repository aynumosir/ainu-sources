import type { ArchivePrincipal } from '$lib/server/archive/types';

type Principal = Pick<ArchivePrincipal, 'userId' | 'role' | 'identity' | 'authn'> | null;

export const archiveSession = $state({
	principal: null as Principal,
	accessChanged: false,
	theme: 'system' as 'system' | 'light' | 'dark'
});

export function seedArchivePrincipal(principal: Principal): void {
	archiveSession.principal = principal;
}

export function archiveFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	return fetch(input, init).then((response) => {
		if (response.status === 403) archiveSession.accessChanged = true;
		return response;
	});
}

export function initializeArchiveTheme(): void {
	if (typeof localStorage === 'undefined') return;
	const stored = localStorage.getItem('archive-theme');
	if (stored === 'light' || stored === 'dark' || stored === 'system') archiveSession.theme = stored;
	applyArchiveTheme();
}

export function setArchiveTheme(theme: 'system' | 'light' | 'dark'): void {
	archiveSession.theme = theme;
	if (typeof localStorage !== 'undefined') localStorage.setItem('archive-theme', theme);
	applyArchiveTheme();
}

export function applyArchiveTheme(): void {
	if (typeof document === 'undefined') return;
	document.documentElement.dataset.archiveTheme = archiveSession.theme;
}
