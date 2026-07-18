export const ARCHIVE_ROLES = [
	'archive_reader',
	'archive_contributor',
	'archive_reviewer',
	'archive_admin'
] as const;

export type ArchiveRole = (typeof ARCHIVE_ROLES)[number];

export type ArchivePrincipal = {
	userId: string;
	role: ArchiveRole;
	identity: { kind: 'access_sub' | 'github_login' | 'service_token' | 'app_session'; value: string };
	authn: 'access_jwt' | 'service_token' | 'mcp_assertion' | 'app_session';
	email?: string;
};

export const ARCHIVE_EVENT_ENTITY_TYPES = [
	'file_revision',
	'upload_session',
	'capability_token',
	'user'
] as const;

export type ArchiveEventEntityType = (typeof ARCHIVE_EVENT_ENTITY_TYPES)[number];

const ROLE_RANK: Record<ArchiveRole, number> = {
	archive_reader: 1,
	archive_contributor: 2,
	archive_reviewer: 3,
	archive_admin: 4
};

export function isArchiveRole(value: string | null | undefined): value is ArchiveRole {
	return ARCHIVE_ROLES.includes(value as ArchiveRole);
}

export function archiveRoleAtLeast(role: ArchiveRole, minRole: ArchiveRole): boolean {
	return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

export function iso(date: Date | number | null | undefined): string | null {
	if (date == null) return null;
	return new Date(date).toISOString();
}
