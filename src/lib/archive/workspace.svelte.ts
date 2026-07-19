import type { EditBuffer } from './workspace';

export type PaneOrder = 'scan-first' | 'text-first';
export type MobilePane = 'scan' | 'text';

export class WorkspaceState {
	currentPage = $state(1);
	paneOrder = $state<PaneOrder>('scan-first');
	mobilePane = $state<MobilePane>('scan');
	buffers = $state<Record<number, EditBuffer>>({});

	constructor(initialPage: number) {
		this.currentPage = initialPage;
	}

	setBuffer(page: number, buffer: EditBuffer): void {
		this.buffers = { ...this.buffers, [page]: buffer };
	}

	clearBuffer(page: number): void {
		const next = { ...this.buffers };
		delete next[page];
		this.buffers = next;
	}

	hasDirtyBuffers(): boolean {
		return Object.values(this.buffers).some((buffer) => buffer.dirty);
	}

	dirtyPages(): number[] {
		return Object.entries(this.buffers)
			.filter(([, buffer]) => buffer.dirty)
			.map(([page]) => Number(page));
	}
}
