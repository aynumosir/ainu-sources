<script lang="ts">
	import { archiveFetch } from '$lib/archive/session.svelte';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import type { ArchiveRole } from '$lib/server/archive/types';

	type AdminUser = {
		userId: string;
		name: string;
		email: string;
		role: ArchiveRole | null;
		roleUpdatedAt: string | null;
		login: string | null;
		serviceToken: string | null;
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

	function detailLine(user: AdminUser): string {
		const details = user.login ? [user.name, user.email] : [user.email];
		if (user.serviceToken) details.push(`service token: ${user.serviceToken}`);
		return details.filter(Boolean).join(' · ');
	}

	function formattedDate(value: string | null): string {
		return value ? new Date(value).toLocaleString('en-US') : '—';
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
				class="text-[17px] font-semibold [--archive-label-en-size:15px]"
			/>
			<p class="mt-1 text-[13px] text-[var(--archive-subtle)]">{users.length} archive users</p>
		</div>
	</div>

	{#if users.length}
		<div class="mt-3 overflow-x-auto">
			<table class="w-full min-w-[720px] border-collapse text-left text-[13px]">
				<thead class="border-b border-[var(--archive-border)] text-[12px] uppercase tracking-wide text-[var(--archive-subtle)]">
					<tr>
						<th class="py-2 pr-4 font-semibold">Login / name</th>
						<th class="py-2 pr-4 font-semibold">Role</th>
						<th class="py-2 pr-4 font-semibold">Changed</th>
					</tr>
				</thead>
				<tbody>
					{#each users as user (user.userId)}
						<tr class="border-b border-[var(--archive-border)] last:border-0">
							<td class="py-2 pr-4 align-top">
								<p class="font-medium text-[var(--archive-text)]">{displayName(user)}</p>
								<p class="mt-1 break-all text-[12px] text-[var(--archive-subtle)]">{detailLine(user)}</p>
							</td>
							<td class="py-2 pr-4 align-top">
								<div class="flex flex-wrap items-center gap-2">
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
									<button
										type="button"
										disabled={saving === user.userId || roleFromValue(selectedRoles[user.userId]) === user.role}
										onclick={() => save(user)}
										class="h-8 border border-[var(--archive-border)] bg-[var(--archive-paper)] px-3 text-[13px] font-medium hover:border-[var(--archive-gilt)] disabled:opacity-60"
									>
										{#if saving === user.userId}
											Saving
										{:else}
											<BilingualLabel ja={archiveLabels.save.ja} en={archiveLabels.save.en} />
										{/if}
									</button>
								</div>
								{#if rowErrors[user.userId]}
									<p class="mt-2 text-[12px] text-[var(--archive-danger)]">{rowErrors[user.userId]}</p>
								{/if}
							</td>
							<td class="py-2 pr-4 align-top text-[var(--archive-subtle)]">
								{#if user.roleUpdatedAt}
									<time datetime={user.roleUpdatedAt}>{formattedDate(user.roleUpdatedAt)}</time>
								{:else}
									{formattedDate(null)}
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
