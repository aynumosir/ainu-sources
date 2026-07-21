export type PageStatus = 'machine' | 'edited' | 'approved' | 'none';
export type EditableVariant = 'edited' | 'manual';
export type ExportVariant = 'working' | 'machine' | 'approved';
export type ExportFormat = 'txt' | 'jsonl';

export type EditBase =
	| { kind: 'edit'; edit_id: string }
	| { kind: 'variant'; variant: string };

export type PageStatusRow = {
	page: number;
	status: PageStatus;
	variant: string;
	manual: boolean;
	edit_id?: string;
};

export type PageText = {
	page: number;
	text: string;
	variant: string;
	status: PageStatus;
	manual: boolean;
	editId: string | null;
	editedBy: string | null;
	editedAt: string | null;
	approvedBy: string | null;
	approvedAt: string | null;
};

export type OcrVariant = {
	name: string;
	label: string;
	kind: 'machine' | EditableVariant;
	status: PageStatus;
	manual: boolean;
};

export type EditBuffer = {
	text: string;
	savedText: string;
	base: EditBase;
	variant: EditableVariant;
	dirty: boolean;
};

export type EditHead = {
	edit_id: string;
	edited_by: string;
	edited_at: string;
	text: string;
};

export type EditLogEntry = {
	kind: 'edit' | 'approve' | 'unapprove' | 'demote' | 'revert';
	edit_id?: string;
	actor: string;
	created_at: string;
	note?: string;
	base_edit_id?: string;
	restored_from?: string;
	text?: string;
};

export type ConflictChoice = 'mine' | 'theirs';

export function makeEditBuffer(input: {
	text?: string;
	base: EditBase;
	variant?: EditableVariant;
}): EditBuffer {
	const text = input.text ?? '';
	return {
		text,
		savedText: text,
		base: input.base,
		variant: input.variant ?? 'edited',
		dirty: false
	};
}

export function updateEditBuffer(buffer: EditBuffer, text: string): EditBuffer {
	return { ...buffer, text, dirty: text !== buffer.savedText };
}

export function restoreIntoBuffer(buffer: EditBuffer, text: string): EditBuffer {
	return { ...buffer, text, dirty: text !== buffer.savedText };
}

export function acceptSavedBuffer(
	buffer: EditBuffer,
	result: { edit_id: string; variant: EditableVariant }
): EditBuffer {
	return {
		text: buffer.text,
		savedText: buffer.text,
		base: { kind: 'edit', edit_id: result.edit_id },
		variant: result.variant,
		dirty: false
	};
}

export function resolveConflictChoice(
	buffer: EditBuffer,
	theirs: EditHead,
	choice: ConflictChoice,
	note = ''
): { buffer: EditBuffer; retry: boolean; note?: string } {
	if (choice === 'theirs') {
		return {
			buffer: {
				...buffer,
				text: theirs.text,
				savedText: theirs.text,
				base: { kind: 'edit', edit_id: theirs.edit_id },
				dirty: false
			},
			retry: false
		};
	}

	const trimmedNote = note.trim();
	if (!trimmedNote) throw new Error('An overwrite note is required.');
	return {
		buffer: { ...buffer, base: { kind: 'edit', edit_id: theirs.edit_id }, dirty: true },
		retry: true,
		note: trimmedNote
	};
}

export function chooseDefaultVariant(variants: OcrVariant[], preferredMachine?: string | null): string | null {
	if (variants.some((variant) => variant.name === 'edited')) return 'edited';
	if (preferredMachine && variants.some((variant) => variant.name === preferredMachine)) return preferredMachine;
	const machine = variants.find((variant) => variant.kind === 'machine');
	if (machine) return machine.name;
	if (variants.some((variant) => variant.name === 'manual')) return 'manual';
	return null;
}

export function shapeExportFilename(
	slug: string,
	revisionNo: number,
	variant: ExportVariant,
	format: ExportFormat
): string {
	const safeSlug = slug
		.trim()
		.toLocaleLowerCase()
		.replace(/[^a-z0-9._-]+/gu, '-')
		.replace(/^[._-]+|[._-]+$/gu, '') || 'archive-text';
	const safeRevision = Number.isSafeInteger(revisionNo) && revisionNo >= 0 ? revisionNo : 0;
	return `${safeSlug}.r${safeRevision}.${variant}.${format}`;
}

export function filenameFromDisposition(value: string | null): string | null {
	if (!value) return null;
	const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(value)?.[1];
	if (encoded) {
		try {
			return decodeURIComponent(encoded);
		} catch {
			return null;
		}
	}
	return /filename="?([^";]+)"?/iu.exec(value)?.[1]?.trim() ?? null;
}
