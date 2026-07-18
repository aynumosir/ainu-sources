<script lang="ts">
	import './archive.css';
	import { onMount } from 'svelte';
	import ArchiveHeader from '$lib/components/archive/ArchiveHeader.svelte';
	import NoAccess from '$lib/components/archive/NoAccess.svelte';
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
		<section class="flex min-h-svh items-center justify-center px-4">
			<div class="w-full max-w-lg rounded-lg border border-[var(--archive-border)] bg-[var(--archive-surface)] p-8 text-center shadow-sm">
				<h1 class="text-[27px] font-semibold">Your access has changed</h1>
				<p class="mt-3 text-[15px] leading-7 text-[var(--archive-subtle)]">
					Reload the archive to refresh your current role and session state.
				</p>
				<button
					type="button"
					onclick={() => location.reload()}
					class="mt-6 rounded-md bg-[var(--archive-accent)] px-4 py-2 text-[15px] font-semibold text-white"
				>
					Reload
				</button>
			</div>
		</section>
	{:else if data.principal}
		<ArchiveHeader principal={data.principal} usage={data.usage} pendingCount={data.pendingCount} />
		<main class="mx-auto max-w-7xl px-4 py-6">
			{@render children()}
		</main>
	{:else}
		<NoAccess login={data.login} hasAppSession={data.hasAppSession} signInHref={data.signInHref} />
	{/if}
</div>
