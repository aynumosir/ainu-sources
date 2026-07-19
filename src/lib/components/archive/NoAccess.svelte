<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import type { SubmitFunction } from '@sveltejs/kit';
	import ArchiveFooter from './ArchiveFooter.svelte';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';

	let {
		login = null,
		hasAppSession = false,
		signInHref = '/login'
	}: { login?: string | null; hasAppSession?: boolean; signInHref?: string } = $props();

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

<div class="flex min-h-svh flex-col">
	<section class="flex flex-1 items-center justify-center px-4 py-16">
		<div class="w-full max-w-lg border border-[var(--archive-border)] bg-[var(--archive-paper)] p-8 text-center shadow-sm">
			<a href="/archive" class="inline-block text-[var(--archive-text)]">
				<span class="archive-wordmark block text-[21px]">aynumosir archive</span>
				<span class="mt-1 block font-[var(--font-archive-jp)] text-[13px] text-[var(--archive-faint-text)]">
					アイヌモシㇼ資料記録庫
				</span>
			</a>
			{#if hasAppSession}
				<BilingualLabel
					tag="h1"
					stacked
					ja={archiveLabels.noRoleHeading.ja}
					en={archiveLabels.noRoleHeading.en}
					class="mt-6 text-[27px] font-semibold [--archive-label-en-size:21px]"
				/>
				{#if login}
					<p class="mt-4 text-[15px] text-[var(--archive-subtle)]">
						You are signed in as
						<code class="archive-mono font-semibold text-[var(--archive-text)]">{login}</code>.
					</p>
				{/if}
				<p class="mt-3 text-[15px] leading-7 text-[var(--archive-subtle)]">
					This archive is a private collection for designated researchers. Ask an archive administrator to grant you access.
				</p>
				<form method="POST" action="/account?/signout" use:enhance={signOutEnhance} class="mt-5">
					<button type="submit" class="text-[13px] font-semibold text-[var(--archive-gilt-text)] underline decoration-dotted underline-offset-4">
						<BilingualLabel ja={archiveLabels.signOut.ja} en={archiveLabels.signOut.en} />
					</button>
				</form>
			{:else}
				<BilingualLabel
					tag="h1"
					stacked
					ja={archiveLabels.signInHeading.ja}
					en={archiveLabels.signInHeading.en}
					class="mt-6 text-[27px] font-semibold [--archive-label-en-size:21px]"
				/>
				<p class="mt-3 text-[15px] leading-7 text-[var(--archive-subtle)]">
					This archive is a private research collection for designated researchers.
				</p>
				<a
					href={signInHref}
					class="mt-6 inline-flex border border-[var(--archive-gilt)] bg-[var(--archive-gilt)] px-4 py-2 text-[15px] font-semibold text-[var(--archive-paper)] hover:bg-[var(--archive-gilt-text)]"
				>
					<BilingualLabel ja={archiveLabels.signIn.ja} en={archiveLabels.signIn.en} />
				</a>
			{/if}
		</div>
	</section>
	<ArchiveFooter />
</div>
