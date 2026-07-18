<script lang="ts">
	import { formatBytes } from '$lib/archive/format';

	let { data } = $props();

	const descriptions = {
		archive_reader: 'Read approved archive files and search OCR text.',
		archive_contributor: 'Read approved files and submit replacement files for review.',
		archive_reviewer: 'Review pending submissions and inspect pending archive material.',
		archive_admin: 'Manage archive roles and administrative settings.'
	};
</script>

{#if data.principal}
	<div class="max-w-3xl space-y-5">
		<div>
			<h1 class="text-[27px] font-semibold">Account</h1>
			<p class="mt-1 text-[15px] text-[var(--archive-subtle)]">Archive identity and access limits.</p>
		</div>

		<section class="rounded-lg border border-[var(--archive-border)] bg-[var(--archive-surface)] p-4">
			<h2 class="text-[17px] font-semibold">Identity</h2>
			<dl class="mt-3 grid gap-2 text-[15px] sm:grid-cols-[10rem_1fr]">
				<dt class="text-[var(--archive-subtle)]">Login</dt>
				<dd>{data.principal.identity.value}</dd>
				<dt class="text-[var(--archive-subtle)]">User id</dt>
				<dd class="archive-mono break-all text-[13px]">{data.principal.userId}</dd>
				<dt class="text-[var(--archive-subtle)]">Role</dt>
				<dd>
					<span class="font-medium">{data.principal.role}</span>
					<p class="mt-1 text-[13px] text-[var(--archive-subtle)]">{descriptions[data.principal.role]}</p>
				</dd>
			</dl>
		</section>

		<section class="rounded-lg border border-[var(--archive-border)] bg-[var(--archive-surface)] p-4">
			<h2 class="text-[17px] font-semibold">Usage</h2>
			{#if data.usage}
				<dl class="mt-3 grid gap-2 text-[15px] sm:grid-cols-[10rem_1fr]">
					<dt class="text-[var(--archive-subtle)]">Bytes used</dt>
					<dd>{formatBytes(data.usage.bytesUsed)} / {formatBytes(data.usage.dailyByteLimit)}</dd>
					<dt class="text-[var(--archive-subtle)]">Reset</dt>
					<dd><time datetime={data.usage.resetAt}>{new Date(data.usage.resetAt).toLocaleString('en-US')}</time></dd>
					<dt class="text-[var(--archive-subtle)]">Streams</dt>
					<dd>{data.usage.activeStreams} / {data.usage.concurrentStreamLimit}</dd>
				</dl>
			{:else}
				<p class="mt-2 text-[15px] text-[var(--archive-subtle)]">Usage summaries are unavailable for assertion-authenticated sessions.</p>
			{/if}
		</section>

		<section class="rounded-lg border border-[var(--archive-border)] bg-[var(--archive-surface)] p-4">
			<h2 class="text-[17px] font-semibold">Audit</h2>
			<p class="mt-2 text-[15px] leading-7 text-[var(--archive-subtle)]">
				Archive downloads and mutation actions are logged with your archive user id.
			</p>
		</section>

		<section class="rounded-lg border border-[var(--archive-border)] bg-[var(--archive-surface)] p-4">
			<h2 class="text-[17px] font-semibold">Sign out</h2>
			<p class="mt-2 text-[15px] text-[var(--archive-subtle)]">
				Cloudflare Access manages this session.
			</p>
			<a href="/cdn-cgi/access/logout" class="mt-3 inline-flex rounded-md border border-[var(--archive-border)] px-3 py-2 text-[13px] font-semibold">
				Sign out of Access
			</a>
		</section>
	</div>
{/if}
