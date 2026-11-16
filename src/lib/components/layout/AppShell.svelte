<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { UserPublic } from '$lib/types/auth';
	import Header from './Header.svelte';
	import BottomNav from './BottomNav.svelte';

	let {
		user = undefined,
		children
	}: {
		user?: UserPublic | null;
		children?: Snippet;
	} = $props();
</script>

<div class="min-h-screen bg-[#0a0a0a] text-[#f2f0eb] selection:bg-[#d4200a] selection:text-white">
	<Header {user} />

	<main class="pb-20 pt-4 md:pb-12 md:pt-8">
		{#if children}
			{@render children()}
		{/if}
	</main>

	<BottomNav />
</div>
