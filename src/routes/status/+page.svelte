<script lang="ts">
	import type { PageData } from './$types';
	import type { GroupWithStatus } from '$lib/types/group';
	import type { OverallStatus, StatusMonitor } from '$lib/types/status';
	import { getOverallStatus } from '$lib/types/status';
	import PublicLayout from '$lib/components/layout/PublicLayout.svelte';

	let { data }: { data: PageData } = $props();

	// Compute overall status across all groups
	function getGlobalStatus(groups: GroupWithStatus[]): OverallStatus {
		const allMonitors: StatusMonitor[] = groups.flatMap((g) => g.monitors);
		return getOverallStatus(allMonitors);
	}

	const globalStatus = $derived(getGlobalStatus(data.groups));

	function getStatusBadge(status: OverallStatus): {
		text: string;
		borderClass: string;
		dotClass: string;
	} {
		switch (status) {
			case 'operational':
				return {
					text: 'Operativo',
					borderClass: 'border-white/15 bg-white/5 text-[#f2f0eb]',
					dotClass: 'bg-[#d4200a]'
				};
			case 'degraded':
				return {
					text: 'Rallentato',
					borderClass: 'border-[#ff5a3d]/40 bg-[#ff5a3d]/10 text-[#ff5a3d]',
					dotClass: 'bg-[#ff5a3d]'
				};
			case 'partial_outage':
				return {
					text: 'Disservizio Parziale',
					borderClass: 'border-[#d4200a]/50 bg-[#d4200a]/15 text-[#ff5a3d]',
					dotClass: 'bg-[#d4200a]'
				};
			case 'major_outage':
				return {
					text: 'Disconnesso',
					borderClass: 'border-[#d4200a] bg-[#d4200a]/20 text-[#ff5a3d]',
					dotClass: 'bg-[#d4200a] animate-ping'
				};
		}
	}

	function formatIncidentTime(dateStr: string): string {
		const date = new Date(dateStr);
		return date.toLocaleDateString('it-IT', {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	function getStatusLabel(status: string): string {
		switch (status) {
			case 'investigating': return 'Indagine in corso';
			case 'identified': return 'Causa identificata';
			case 'monitoring': return 'Sotto monitoraggio';
			case 'resolved': return 'Risolto';
			default: return status;
		}
	}
</script>

<svelte:head>
	<title>HASTE — System Status</title>
</svelte:head>

<PublicLayout>
	<!-- Overall Status Hero Banner -->
	{#if globalStatus === 'operational'}
		<div class="relative mb-10 overflow-hidden rounded-xl border border-white/10 bg-[#121212] p-8 sm:p-10 shadow-[0_4px_30px_rgba(0,0,0,0.6)]">
			<div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
				<div class="flex items-center gap-4">
					<div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border border-white/15 bg-white/5 text-[#f2f0eb]">
						<svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M5 13l4 4L19 7" />
						</svg>
					</div>
					<div>
						<h1 class="text-2xl font-bold tracking-tight text-[#f2f0eb] sm:text-3xl">
							Tutti i sistemi sono operativi
						</h1>
						<p class="mt-1 text-sm text-neutral-400 font-mono">
							Infrastruttura edge Cloudflare e servizi HASTE Collective al 100% delle prestazioni.
						</p>
					</div>
				</div>
				<div class="shrink-0 self-start sm:self-center">
					<div class="inline-flex items-center gap-2 border border-white/15 bg-white/5 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-[#f2f0eb]">
						<span class="inline-block h-[5px] w-[5px] bg-[#d4200a]"></span>
						<span>Live Status</span>
					</div>
				</div>
			</div>
		</div>
	{:else}
		<div class="relative mb-10 overflow-hidden rounded-xl border border-[#d4200a]/50 bg-[#160d0d] p-8 sm:p-10 shadow-[0_0_30px_rgba(212,32,10,0.15)]">
			<div class="flex items-center gap-4">
				<div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[#d4200a]/20 text-[#d4200a] border border-[#d4200a]/40">
					<svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
					</svg>
				</div>
				<div>
					<h1 class="text-2xl font-bold tracking-tight text-[#f2f0eb] sm:text-3xl">
						Disservizio Rilevato
					</h1>
					<p class="mt-1 text-sm text-neutral-400 font-mono">
						Uno o più servizi stanno riscontrando anomalie di connessione.
					</p>
				</div>
			</div>
		</div>
	{/if}

	<!-- Active Incidents -->
	{#if data.activeIncidents.length > 0}
		<div class="mb-10 space-y-4">
			<h2 class="text-xs font-mono font-semibold uppercase tracking-widest text-neutral-400">Incidenti in corso</h2>
			{#each data.activeIncidents as incident (incident.id)}
				<div class="rounded-xl border border-[#d4200a]/40 bg-[#160d0d] p-5">
					<div class="flex items-center gap-2">
						<span class="inline-block h-[5px] w-[5px] bg-[#d4200a]"></span>
						<h3 class="font-semibold text-[#f2f0eb]">{incident.title}</h3>
						{#if incident.group_name}
							<span class="border border-white/10 bg-white/5 px-2 py-0.5 text-xs font-mono text-neutral-300">
								{incident.group_name}
							</span>
						{/if}
					</div>
					{#if incident.updates.length > 0}
						<p class="mt-2 text-sm text-neutral-300 font-mono">
							<span class="font-medium text-[#d4200a]">{getStatusLabel(incident.updates[0].status)}</span> — {incident.updates[0].message}
						</p>
						<p class="mt-2 text-xs font-mono text-neutral-500">
							{formatIncidentTime(incident.updates[0].created_at)}
						</p>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	<!-- Section Title -->
	<div class="mb-4 flex items-center justify-between">
		<h2 class="text-xs font-mono font-semibold uppercase tracking-widest text-neutral-400">
			Gruppi di Servizi & Infrastruttura
		</h2>
		<span class="text-xs font-mono text-neutral-500">
			Controllo ogni 60s
		</span>
	</div>

	<!-- Group Cards -->
	{#if data.groups.length > 0}
		<div class="grid gap-5 sm:grid-cols-2 lg:grid-cols-2">
			{#each data.groups as group (group.id)}
				{@const badge = getStatusBadge(group.overall_status)}
				<a
					href="/status/{group.slug}"
					class="group relative flex flex-col justify-between overflow-hidden rounded-xl border border-white/10 bg-[#121212] p-6 transition duration-200 hover:border-white/25 hover:bg-[#151515] hover:shadow-[0_4px_24px_rgba(0,0,0,0.5)]"
				>
					<div class="flex items-start justify-between gap-4">
						<div>
							<h3 class="text-lg font-bold tracking-tight text-[#f2f0eb] group-hover:text-[#d4200a] transition-colors">
								{group.name}
							</h3>
							{#if group.description}
								<p class="mt-1.5 text-xs text-neutral-400 leading-relaxed font-mono">
									{group.description}
								</p>
							{/if}
						</div>
						<div class="inline-flex shrink-0 items-center gap-2 border px-2.5 py-1 text-xs font-mono uppercase tracking-wider {badge.borderClass}">
							<span class="inline-block h-[5px] w-[5px] {badge.dotClass}"></span>
							<span class="text-[11px] font-mono">{badge.text}</span>
						</div>
					</div>

					<div class="mt-8 flex items-center justify-between border-t border-white/5 pt-4 text-xs font-mono text-neutral-400">
						<span class="text-neutral-400">
							{group.monitors.length} monitor monitorat{group.monitors.length === 1 ? 'o' : 'i'}
						</span>
						<span class="font-medium text-[#f2f0eb]">
							{group.uptime_90d.toFixed(2)}% uptime
						</span>
					</div>
				</a>
			{/each}
		</div>
	{:else}
		<div class="rounded-xl border border-white/10 bg-[#121212] p-12 text-center text-sm font-mono text-neutral-400">
			Nessun servizio pubblico configurato.
		</div>
	{/if}
</PublicLayout>
