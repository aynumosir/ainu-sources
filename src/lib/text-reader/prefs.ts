/** Layer choices of the text reader, kept in this browser. */
export type ReaderPrefs = { source?: boolean; translation?: boolean; kana?: boolean };

const STORAGE_KEY = 'text-reader-prefs-v1';

export function readReaderPrefs(): ReaderPrefs {
	if (typeof localStorage === 'undefined') return {};
	try {
		const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
		return value && typeof value === 'object' ? (value as ReaderPrefs) : {};
	} catch {
		return {};
	}
}

export function writeReaderPrefs(patch: ReaderPrefs): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readReaderPrefs(), ...patch }));
	} catch {
		// The toggles still work for this page when storage is unavailable.
	}
}
