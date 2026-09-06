<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';

	let { open = false }: { open?: boolean } = $props();
</script>

<details {open} class="mt-3 text-sm text-stone-600">
	<summary class="cursor-pointer font-medium text-ink">{m.person_roles_heading()}</summary>
	<div class="mt-2 space-y-1">
		<p>{m.person_role_author_help()}</p>
		<p>{m.person_role_speaker_help()}</p>
		<p>{m.person_role_recorder_help()}</p>
		<p>{m.person_roles_help()}</p>
	</div>
</details>
