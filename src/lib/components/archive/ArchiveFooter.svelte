<script lang="ts">
	import { SITE_ORIGIN } from '$lib/seo';
</script>

<footer class="border-t border-[var(--archive-border)] px-4 py-5 text-[12.5px] leading-6 text-[var(--archive-faint-text)]">
	<div class="mx-auto max-w-7xl">
		<p>aynumosir archive — private research collection · access is audited</p>
		<p class="font-(family-name:--font-archive-jp)">
			アイヌモシㇼ資料記録庫 · 公開目録
			<a href={SITE_ORIGIN} target="_blank" rel="noopener noreferrer" class="text-[var(--archive-gilt-text)] underline decoration-dotted underline-offset-4">
				db.aynu.org ↗
			</a>
		</p>
	</div>
</footer>
