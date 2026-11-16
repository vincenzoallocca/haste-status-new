<script lang="ts">
	import type { DailyStatus } from '$lib/types/status';

	interface Props {
		name: string;
		days: DailyStatus[];
		uptimePercent: number;
		currentStatus: 'up' | 'down' | 'degraded' | null;
	}

	let { name, days, uptimePercent, currentStatus }: Props = $props();

	function getStatusColor(status: 'up' | 'down' | 'degraded' | 'none'): string {
		switch (status) {
			case 'up':
				return 'bg-[#f2f0eb]/75 hover:bg-[#f2f0eb]';
			case 'down':
				return 'bg-[#d4200a] hover:bg-[#ff3b20]';
			case 'degraded':
				return 'bg-[#ff5a3d]/70 hover:bg-[#ff5a3d]';
			default:
				return 'bg-neutral-800/80 hover:bg-neutral-700';
		}
	}

	function getStatusText(status: 'up' | 'down' | 'degraded' | null): string {
		switch (status) {
			case 'up':
				return 'Operativo';
			case 'down':
				return 'Disconnesso';
			case 'degraded':
				return 'Rallentato';
			default:
				return 'Sconosciuto';
		}
	}

	function getStatusTextColor(status: 'up' | 'down' | 'degraded' | null): string {
		switch (status) {
			case 'up':
				return 'text-[#f2f0eb]';
			case 'down':
				return 'text-[#d4200a]';
			case 'degraded':
				return 'text-[#ff5a3d]';
			default:
				return 'text-neutral-500';
		}
	}

	function formatDate(dateStr: string): string {
		const date = new Date(dateStr);
		return date.toLocaleDateString('it-IT', { month: 'short', day: 'numeric', year: 'numeric' });
	}

	let hoveredDay = $state<DailyStatus | null>(null);
	let tooltipX = $state(0);
	let tooltipY = $state(0);

	function handleMouseEnter(day: DailyStatus, event: MouseEvent) {
		hoveredDay = day;
		const rect = (event.target as HTMLElement).getBoundingClientRect();
		tooltipX = rect.left + rect.width / 2;
		tooltipY = rect.top;
	}

	function handleMouseLeave() {
		hoveredDay = null;
	}
</script>

<div class="rounded-xl border border-white/10 bg-[#121212] p-5 transition hover:border-white/20">
	<div class="mb-3 flex items-center justify-between">
		<span class="font-bold tracking-tight text-[#f2f0eb]">{name}</span>
		<div class="flex items-center gap-2 font-mono text-xs font-semibold {getStatusTextColor(currentStatus)}">
			<span class="inline-block h-[5px] w-[5px] {currentStatus === 'up' ? 'bg-[#d4200a]' : currentStatus === 'down' ? 'bg-[#d4200a] animate-ping' : currentStatus === 'degraded' ? 'bg-[#ff5a3d]' : 'bg-neutral-600'}"></span>
			<span class="uppercase tracking-wider">{getStatusText(currentStatus)}</span>
		</div>
	</div>

	<!-- 90-day bars -->
	<div class="mb-3 flex gap-[2px]">
		{#each days as day (day.date)}
			<button
				type="button"
				class="h-7 flex-1 rounded-[1px] transition-colors {getStatusColor(day.status)}"
				onmouseenter={(e) => handleMouseEnter(day, e)}
				onmouseleave={handleMouseLeave}
				aria-label="{formatDate(day.date)}: {day.status}"
			></button>
		{/each}
	</div>

	<div class="flex items-center justify-between font-mono text-xs text-neutral-400">
		<span>90 giorni fa</span>
		<span class="font-semibold text-[#f2f0eb]">{uptimePercent.toFixed(2)}% uptime</span>
		<span>Oggi</span>
	</div>
</div>

<!-- Tooltip -->
{#if hoveredDay}
	<div
		class="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-lg border border-white/15 bg-[#1a1a1a] px-3 py-1.5 font-mono text-xs text-white shadow-2xl backdrop-blur"
		style="left: {tooltipX}px; top: {tooltipY - 8}px;"
	>
		<p class="font-semibold text-white">{formatDate(hoveredDay.date)}</p>
		<p class="text-neutral-400 capitalize">Stato: <span class="{hoveredDay.status === 'up' ? 'text-[#f2f0eb]' : hoveredDay.status === 'degraded' ? 'text-[#ff5a3d]' : 'text-[#d4200a]'}">{getStatusText(hoveredDay.status === 'none' ? null : hoveredDay.status)}</span></p>
		{#if hoveredDay.downtime_minutes > 0}
			<p class="text-[#d4200a]">Downtime: {hoveredDay.downtime_minutes} min</p>
		{/if}
	</div>
{/if}
