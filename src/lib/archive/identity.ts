import type { ArchiveRoleName } from './roles';

const ROLE_LABELS: Record<ArchiveRoleName, string> = {
	archive_reader: 'Reader',
	archive_contributor: 'Contributor',
	archive_reviewer: 'Reviewer',
	archive_admin: 'Administrator'
};

export function archiveRoleLabel(role: ArchiveRoleName): string {
	return ROLE_LABELS[role];
}

export function archiveDisplayName(
	profileName: string | null | undefined,
	email: string | null | undefined,
	role: ArchiveRoleName
): string {
	const name = profileName?.trim();
	if (name) return name;
	const localPart = email?.trim().split('@', 1)[0]?.trim();
	return localPart || archiveRoleLabel(role);
}
