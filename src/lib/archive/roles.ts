export type ArchiveRoleName =
	| 'archive_reader'
	| 'archive_contributor'
	| 'archive_reviewer'
	| 'archive_admin';

const ROLE_RANK: Record<ArchiveRoleName, number> = {
	archive_reader: 1,
	archive_contributor: 2,
	archive_reviewer: 3,
	archive_admin: 4
};

export function archiveRoleAtLeastClient(role: ArchiveRoleName, minRole: ArchiveRoleName): boolean {
	return ROLE_RANK[role] >= ROLE_RANK[minRole];
}
