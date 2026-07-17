function asciiFallback(value: string): string {
	const stripped = value
		.normalize('NFKD')
		.replace(/[^\x20-\x7e]/gu, '')
		.replace(/[\\"]/gu, '_')
		.trim();
	return stripped || 'archive-file';
}

export function contentDisposition(disposition: string | null, filename: string): string {
	const kind = disposition === 'attachment' ? 'attachment' : 'inline';
	const fallback = asciiFallback(filename);
	return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
