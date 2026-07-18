<script lang="ts">
	let { login = null }: { login?: string | null } = $props();
</script>

<section class="flex min-h-[70svh] items-center justify-center px-4 py-16">
	<div class="w-full max-w-lg rounded-lg border border-[var(--archive-border)] bg-[var(--archive-surface)] p-8 shadow-sm">
		<p class="text-[13px] font-semibold uppercase tracking-wide text-[var(--archive-subtle)]">Archive access</p>
		<h1 class="mt-2 text-[27px] font-semibold text-[var(--archive-text)]">No archive role is assigned</h1>
		{#if login}
			<p class="mt-4 text-[15px] text-[var(--archive-subtle)]">
				You're signed in as <strong class="font-semibold text-[var(--archive-text)]">{login}</strong>.
			</p>
		{/if}
		<p class="mt-3 text-[15px] leading-7 text-[var(--archive-subtle)]">
			This archive is restricted to designated researchers. Ask an archive administrator to grant you access.
		</p>
	</div>
</section>
