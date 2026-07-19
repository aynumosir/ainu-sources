export function formatBytes(bytes: number | null | undefined): string {
	if (bytes == null || !Number.isFinite(bytes)) return 'unknown size';
	const abs = Math.abs(bytes);
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = abs;
	let unit = units[0];
	for (let index = 0; index < units.length - 1 && value >= 1000; index += 1) {
		value /= 1000;
		unit = units[index + 1];
	}
	const shown = unit === 'B' || value >= 10 ? Math.round(value).toString() : value.toFixed(1);
	return `${bytes < 0 ? '-' : ''}${shown} ${unit}`;
}

export function middleEllipsis(value: string | null | undefined, head = 10, tail = 8): string {
	if (!value) return '';
	if (value.length <= head + tail + 1) return value;
	return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
	if (value == null || value === '') return '—';
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return '—';
	const pad = (part: number) => String(part).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
