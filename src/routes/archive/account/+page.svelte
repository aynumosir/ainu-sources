<script lang="ts">
	import ArchiveHead from '$lib/components/archive/ArchiveHead.svelte';
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { formatBytes, formatDateTime } from '$lib/archive/format';
	import BilingualLabel from '$lib/components/archive/BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';
	import type { SubmitFunction } from '@sveltejs/kit';

	let { data } = $props();

	const descriptions = {
		archive_reader: 'Read approved archive files and search OCR text.',
		archive_contributor: 'Read approved files and submit replacement files for review.',
		archive_reviewer: 'Review pending submissions and inspect pending archive material.',
		archive_admin: 'Manage archive roles and administrative settings.'
	};

	const signOutEnhance: SubmitFunction = () => {
		return async ({ result, update }) => {
			if (result.type === 'success' || result.type === 'redirect') {
				await goto('/archive', { invalidateAll: true });
				return;
			}
			await update();
		};
	};
</script>

<ArchiveHead title="アカウント Account" />


{#if data.principal}
	<div class="max-w-3xl space-y-5">
		<div class="archive-rule-dotted pb-3">
			<BilingualLabel
				tag="h1"
				stacked
				ja={archiveLabels.account.ja}
				en={archiveLabels.account.en}
				class="archive-h1"
			/>
			<p class="mt-1 text-[15px] text-[var(--archive-subtle)]">Archive identity and access limits.</p>
		</div>

		<section class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-4">
			<BilingualLabel
				tag="h2"
				ja={archiveLabels.identity.ja}
				en={archiveLabels.identity.en}
				class="text-[17px] font-semibold"
			/>
			<dl class="mt-3 grid gap-2 text-[15px] sm:grid-cols-[10rem_1fr]">
				<dt class="text-[var(--archive-subtle)]">Name</dt>
				<dd>{data.displayName}</dd>
				<dt class="text-[var(--archive-subtle)]">account id</dt>
				<dd class="archive-mono break-all text-[12px] text-[var(--archive-subtle)]">{data.principal.identity.value}</dd>
				<dt class="text-[var(--archive-subtle)]">Role</dt>
				<dd>
					<span class="font-medium">{data.principal.role}</span>
					<p class="mt-1 text-[13px] text-[var(--archive-subtle)]">{descriptions[data.principal.role]}</p>
				</dd>
			</dl>
		</section>

		<section class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-4">
			<BilingualLabel
				tag="h2"
				ja={archiveLabels.usage.ja}
				en={archiveLabels.usage.en}
				class="text-[17px] font-semibold"
			/>
			{#if data.usage}
				<dl class="mt-3 grid gap-2 text-[15px] sm:grid-cols-[10rem_1fr]">
					<dt class="text-[var(--archive-subtle)]">Bytes used</dt>
					<dd>{formatBytes(data.usage.bytesUsed)} / {formatBytes(data.usage.dailyByteLimit)}</dd>
					<dt class="text-[var(--archive-subtle)]">Reset</dt>
					<dd><time class="tnum" datetime={data.usage.resetAt}>{formatDateTime(data.usage.resetAt)}</time></dd>
					<dt class="text-[var(--archive-subtle)]">Streams</dt>
					<dd>{data.usage.activeStreams} / {data.usage.concurrentStreamLimit}</dd>
				</dl>
			{:else}
				<p class="mt-2 text-[15px] text-[var(--archive-subtle)]">Usage summaries are unavailable for assertion-authenticated sessions.</p>
			{/if}
		</section>

		{#if data.principal.role === 'archive_admin'}
			<section class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-4">
				<BilingualLabel
					tag="h2"
					ja={archiveLabels.administration.ja}
					en={archiveLabels.administration.en}
					class="text-[17px] font-semibold"
				/>
				<p class="mt-2 text-[15px] leading-7 text-[var(--archive-subtle)]">
					Manage archive roles and administrative settings.
				</p>
				<a href="/archive/admin" class="mt-3 inline-flex border border-[var(--archive-border)] bg-[var(--archive-paper)] px-3 py-2 text-[13px] font-semibold hover:border-[var(--archive-gilt)]">
					Open admin
				</a>
			</section>
		{/if}

		<section class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-4">
			<BilingualLabel
				tag="h2"
				ja={archiveLabels.audit.ja}
				en={archiveLabels.audit.en}
				class="text-[17px] font-semibold"
			/>
			<p class="mt-2 text-[15px] leading-7 text-[var(--archive-subtle)]">
				Archive downloads and mutation actions are logged with your archive user id.
			</p>
		</section>

		<section class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-4">
			<BilingualLabel
				tag="h2"
				ja={archiveLabels.signOut.ja}
				en={archiveLabels.signOut.en}
				class="text-[17px] font-semibold"
			/>
			<p class="mt-2 text-[15px] text-[var(--archive-subtle)]">
				End the app session for this archive.
			</p>
			<form method="POST" action="/account?/signout" use:enhance={signOutEnhance} class="mt-3">
				<button type="submit" aria-label={bilingualAriaLabel(archiveLabels.signOut)} class="inline-flex border border-[var(--archive-border)] bg-[var(--archive-paper)] px-3 py-2 text-[13px] font-semibold hover:border-[var(--archive-gilt)]">
					<BilingualLabel ja={archiveLabels.signOut.ja} en={archiveLabels.signOut.en} />
				</button>
			</form>
		</section>
	</div>
{/if}
