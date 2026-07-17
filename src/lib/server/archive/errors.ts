export class ArchiveHttpError extends Error {
	constructor(
		public status: number,
		message: string
	) {
		super(message);
	}
}

export function assertArchiveHttpError(error: unknown): ArchiveHttpError {
	if (error instanceof ArchiveHttpError) return error;
	return new ArchiveHttpError(500, 'archive request failed');
}
