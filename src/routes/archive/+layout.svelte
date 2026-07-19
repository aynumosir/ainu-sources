<script lang="ts">
	import './archive.css';
	import { onMount } from 'svelte';
	import ArchiveMasthead from '$lib/components/archive/ArchiveMasthead.svelte';
	import ArchiveFooter from '$lib/components/archive/ArchiveFooter.svelte';
	import BilingualLabel from '$lib/components/archive/BilingualLabel.svelte';
	import NoAccess from '$lib/components/archive/NoAccess.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import { archiveSession, initializeArchiveTheme, seedArchivePrincipal } from '$lib/archive/session.svelte';
	import { seedArchiveUsage } from '$lib/archive/usage.svelte';

	let { children, data } = $props();

	$effect(() => {
		seedArchivePrincipal(data.principal);
		seedArchiveUsage(data.usage);
	});

	onMount(() => {
		initializeArchiveTheme();
	});
</script>

<div class="archive">
	{#if archiveSession.accessChanged}
		<div class="flex min-h-svh flex-col">
			<section class="flex flex-1 items-center justify-center px-4 py-16">
				<div class="w-full max-w-lg border border-[var(--archive-border)] bg-[var(--archive-paper)] p-8 text-center shadow-sm">
					<a href="/archive" class="inline-block text-[var(--archive-text)]">
						<span class="archive-wordmark block text-[21px]">aynumosir archive</span>
						<span class="mt-1 block font-[var(--font-archive-jp)] text-[13px] text-[var(--archive-faint-text)]">
							アイヌモシㇼ資料記録庫
						</span>
					</a>
					<BilingualLabel
						tag="h1"
						stacked
						ja={archiveLabels.accessChanged.ja}
						en={archiveLabels.accessChanged.en}
						class="mt-6 text-[27px] font-semibold [--archive-label-en-size:21px]"
					/>
					<p class="mt-3 text-[15px] leading-7 text-[var(--archive-subtle)]">
						Reload the archive to refresh your current role and session state.
					</p>
					<button
						type="button"
						onclick={() => location.reload()}
						class="mt-6 border border-[var(--archive-gilt)] bg-[var(--archive-gilt)] px-4 py-2 text-[15px] font-semibold text-[var(--archive-paper)] hover:bg-[var(--archive-gilt-text)]"
					>
						Reload
					</button>
				</div>
			</section>
			<ArchiveFooter />
		</div>
	{:else if data.principal}
		<div class="flex min-h-svh flex-col">
			<ArchiveMasthead principal={data.principal} usage={data.usage} pendingCount={data.pendingCount} />
			<main class="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
				{@render children()}
			</main>
			<ArchiveFooter />
		</div>
	{:else}
		<NoAccess login={data.login} hasAppSession={data.hasAppSession} signInHref={data.signInHref} />
	{/if}
</div>
