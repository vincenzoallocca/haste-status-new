<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { MonitorStatus } from '$lib/types/monitor';

	type BadgeVariant = 'success' | 'error' | 'warning' | 'info' | 'neutral';
	type BadgeSize = 'sm' | 'md' | 'lg';

	let {
		variant = 'neutral',
		size = 'sm',
		status = undefined,
		class: className = '',
		children
	}: {
		variant?: BadgeVariant;
		size?: BadgeSize;
		status?: MonitorStatus | null;
		class?: string;
		children?: Snippet;
	} = $props();

	// Map monitor status to badge variant
	const statusToVariant: Record<MonitorStatus, BadgeVariant> = {
		up: 'success',
		down: 'error',
		degraded: 'warning'
	};

	const resolvedVariant = $derived(status ? statusToVariant[status] : variant);

	const variantStyles: Record<BadgeVariant, string> = {
		success: 'bg-white/10 text-[#f2f0eb] border border-white/20',
		error: 'bg-[#d4200a]/15 text-[#ff5a3d] border border-[#d4200a]/30',
		warning: 'bg-[#ff5a3d]/10 text-[#ff5a3d] border border-[#ff5a3d]/20',
		info: 'bg-white/5 text-[#f2f0eb] border border-white/10',
		neutral: 'bg-white/5 text-neutral-400 border border-white/10'
	};

	const sizeStyles: Record<BadgeSize, string> = {
		sm: 'px-2 py-0.5 text-xs',
		md: 'px-2.5 py-1 text-sm',
		lg: 'px-3 py-1.5 text-base'
	};

	const computedStyles = $derived(
		`inline-flex items-center font-mono font-medium rounded ${variantStyles[resolvedVariant]} ${sizeStyles[size]} ${className}`
	);
</script>

<span class={computedStyles}>
	{#if status}
		{status.toUpperCase()}
	{:else if children}
		{@render children()}
	{:else}
		UNKNOWN
	{/if}
</span>
