<script lang="ts">
	import { formatDateTime, middleEllipsis } from '$lib/archive/format';
	import { archiveFetch } from '$lib/archive/session.svelte';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';
	import type { ArchiveRole } from '$lib/server/archive/types';

	type AdminUserKind = 'person' | 'system' | 'machine';

	type AdminUser = {
		userId: string;
		name: string;
		email: string;
		role: ArchiveRole | null;
		roleUpdatedAt: string | null;
		login: string | null;
		serviceToken: string | null;
		kind?: AdminUserKind;
	};

	type RoleValue = ArchiveRole | '';

	const roles: ArchiveRole[] = [
		'archive_reader',
		'archive_contributor',
		'archive_reviewer',
		'archive_admin'
	];

	let { users }: { users: AdminUser[] } = $props();
	let selectedRoles = $state<Record<string, RoleValue>>({});
	let rowErrors = $state<Record<string, string>>({});
	let saving = $state<string | null>(null);
	const roleHolderCount = $derived(users.filter((user) => user.role !== null).length);

	$effect(() => {
		selectedRoles = initialSelected(users);
	});

	function initialSelected(rows: AdminUser[]): Record<string, RoleValue> {
		const values: Record<string, RoleValue> = {};
		for (const user of rows) values[user.userId] = user.role ?? '';
		return values;
	}

	function roleFromValue(value: RoleValue | undefined): ArchiveRole | null {
		return value && roles.includes(value) ? value : null;
	}

	function displayName(user: AdminUser): string {
		return user.login ?? user.name ?? user.email;
	}

	function rowKind(user: AdminUser): AdminUserKind {
		return user.kind ?? (user.serviceToken ? 'machine' : 'person');
	}

	function tokenLabel(value: string): string {
		const shortened = middleEllipsis(value, 6, 4);
		return shortened === value ? `${value.slice(0, Math.max(1, Math.min(3, value.length)))}...` : shortened;
	}

	function kindLabel(kind: AdminUserKind): { ja: string; en: string } | null {
		if (kind === 'system') return archiveLabels.systemPrincipal;
		if (kind === 'machine') return archiveLabels.machinePrincipal;
		return null;
	}

	function confirmRoleChange(user: AdminUser, nextRole: ArchiveRole | null): boolean {
		if (nextRole === null) return confirm(`Remove archive role for ${displayName(user)}?`);
		if (user.role === 'archive_admin' && nextRole !== 'archive_admin') {
			return confirm(`Change ${displayName(user)} from archive_admin to ${nextRole}?`);
		}
		return true;
	}

	async function failureMessage(response: Response): Promise<string> {
		try {
			const body: unknown = await response.json();
			if (hasMessage(body)) return body.message;
		} catch {
			return `Role update failed (${response.status}).`;
		}
		return `Role update failed (${response.status}).`;
	}

	function hasMessage(value: unknown): value is { message: string } {
		return !!value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string';
	}

	async function save(user: AdminUser): Promise<void> {
		const nextRole = roleFromValue(selectedRoles[user.userId]);
		if (nextRole === user.role) return;
		if (!confirmRoleChange(user, nextRole)) return;
		saving = user.userId;
		rowErrors[user.userId] = '';
		try {
			const csrf = await archiveFetch('/api/archive/csrf');
			if (!csrf.ok) throw new Error('Could not issue CSRF token.');
			const { token } = (await csrf.json()) as { token: string };
			const response = await archiveFetch(`/api/archive/admin/users/${encodeURIComponent(user.userId)}/role`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-archive-csrf': token
				},
				body: JSON.stringify({ role: nextRole })
			});
			if (!response.ok) throw new Error(await failureMessage(response));
			location.reload();
		} catch (e) {
			rowErrors[user.userId] = e instanceof Error ? e.message : 'Role update failed.';
		} finally {
			saving = null;
		}
	}
</script>

<section class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-4">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<div>
			<BilingualLabel
				tag="h2"
				ja={archiveLabels.users.ja}
				en={archiveLabels.users.en}
				class="text-[17px] font-semibold"
			/>
			<div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-[var(--archive-subtle)]">
				<p><span class="tnum text-[var(--archive-text)]">{roleHolderCount}</span> <BilingualLabel ja={archiveLabels.roleHolders.ja} en={archiveLabels.roleHolders.en} /></p>
				<p><span class="tnum text-[var(--archive-text)]">{users.length}</span> <BilingualLabel ja={archiveLabels.totalUsers.ja} en={archiveLabels.totalUsers.en} /></p>
			</div>
		</div>
	</div>

	{#if users.length}
		<div class="mt-3 overflow-x-auto">
			<table class="w-full min-w-[720px] border-collapse text-left text-[13px]">
				<thead class="border-b border-[var(--archive-border)] text-[12px] uppercase tracking-wide text-[var(--archive-subtle)]">
					<tr>
						<th class="py-2 pr-4 font-semibold"><BilingualLabel ja={archiveLabels.loginName.ja} en={archiveLabels.loginName.en} /></th>
						<th class="py-2 pr-4 font-semibold"><BilingualLabel ja={archiveLabels.role.ja} en={archiveLabels.role.en} /></th>
						<th class="py-2 pr-4 font-semibold"><BilingualLabel ja={archiveLabels.changed.ja} en={archiveLabels.changed.en} /></th>
					</tr>
				</thead>
				<tbody>
					{#each users as user (user.userId)}
						<tr class={`border-b border-[var(--archive-border)] last:border-0 ${rowKind(user) === 'person' ? '' : 'bg-[var(--archive-muted)]/40'}`}>
							<td class="py-2 pr-4 align-top">
								<p class="font-medium text-[var(--archive-text)]">{displayName(user)}</p>
								{#if user.email}
									<p class="mt-1 break-all text-[12px] text-[var(--archive-subtle)]">{user.email}</p>
								{/if}
								<div class="mt-2 flex flex-wrap gap-1.5">
									{#if user.login}
										<span class="archive-mono inline-flex items-center gap-1 border border-[var(--archive-border)] bg-[var(--archive-panel)] px-1.5 py-0.5 text-[11px] text-[var(--archive-subtle)]">
											<span class="font-[var(--font-archive-sans)]">github:</span>
											{user.login}
										</span>
									{/if}
									{#if user.serviceToken}
										<span class="archive-mono inline-flex items-center gap-1 border border-[var(--archive-border)] bg-[var(--archive-panel)] px-1.5 py-0.5 text-[11px] text-[var(--archive-subtle)]">
											<span class="font-[var(--font-archive-sans)]">token:</span>
											{tokenLabel(user.serviceToken)}
										</span>
									{/if}
									{#if rowKind(user) === 'machine'}
										<span class="inline-flex border border-[var(--archive-border)] bg-[var(--archive-muted)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--archive-subtle)]">
											<BilingualLabel ja={archiveLabels.machinePrincipal.ja} en={archiveLabels.machinePrincipal.en} />
										</span>
									{/if}
								</div>
							</td>
							<td class="py-2 pr-4 align-top">
								<div class="flex flex-wrap items-center gap-2">
									{#if rowKind(user) === 'system'}
										<span class="inline-flex border border-[var(--archive-border)] bg-[var(--archive-muted)] px-2 py-1 text-[12px] font-medium text-[var(--archive-subtle)]">
											<BilingualLabel ja={kindLabel(rowKind(user))?.ja ?? archiveLabels.systemPrincipal.ja} en={kindLabel(rowKind(user))?.en ?? archiveLabels.systemPrincipal.en} />
										</span>
									{:else}
										<label class="sr-only" for={`role-${user.userId}`}>Role</label>
										<select
											id={`role-${user.userId}`}
											bind:value={selectedRoles[user.userId]}
											class="h-8 border border-[var(--archive-border)] bg-[var(--archive-panel)] px-2 text-[13px] text-[var(--archive-text)]"
										>
											<option value="">— none —</option>
											{#each roles as role}
												<option value={role}>{role}</option>
											{/each}
										</select>
										{#if roleFromValue(selectedRoles[user.userId]) !== user.role}
											<button
												type="button"
												aria-label={bilingualAriaLabel(archiveLabels.save)}
												disabled={saving === user.userId}
												onclick={() => save(user)}
												class="h-8 border border-[var(--archive-gilt)] bg-[var(--archive-gilt)] px-3 text-[13px] font-semibold text-[var(--archive-paper)] hover:bg-[var(--archive-gilt-text)] disabled:opacity-60"
											>
												{#if saving === user.userId}
													Saving
												{:else}
													<BilingualLabel ja={archiveLabels.save.ja} en={archiveLabels.save.en} inverse />
												{/if}
											</button>
										{/if}
									{/if}
								</div>
								{#if rowErrors[user.userId]}
									<p class="mt-2 text-[12px] text-[var(--archive-danger)]">{rowErrors[user.userId]}</p>
								{/if}
							</td>
							<td class="py-2 pr-4 align-top text-[var(--archive-subtle)]">
								{#if user.roleUpdatedAt}
									<time class="tnum" datetime={user.roleUpdatedAt}>{formatDateTime(user.roleUpdatedAt)}</time>
								{:else}
									<span class="tnum">{formatDateTime(null)}</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<div class="mt-3 text-[13px] text-[var(--archive-subtle)]">
			<BilingualLabel ja={archiveLabels.noUsersFound.ja} en={archiveLabels.noUsersFound.en} />
		</div>
	{/if}
</section>
