<script lang="ts">
	import type { PageData } from './$types';
	import PublicLayout from '$lib/components/layout/PublicLayout.svelte';
	import UptimeBars from '$lib/components/UptimeBars.svelte';

	let { data }: { data: PageData } = $props();

	const isOperational = $derived(data.group ? data.group.overall_status === 'operational' : false);

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
	<title>{data.group?.name ?? 'Gruppo'} — HASTE Status</title>
</svelte:head>

<PublicLayout>
	<!-- Back link -->
	<a
		href="/status"
		class="mb-6 inline-flex items-center gap-1.5 font-mono text-xs text-neutral-400 hover:text-white transition"
	>
		<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
		</svg>
		Torna a tutti i servizi
	</a>

	{#if data.dbUnavailable || !data.group}
		<div class="relative mb-10 overflow-hidden rounded-xl border border-white/10 bg-[#121212] p-8 sm:p-10 shadow-lg text-center">
			<h1 class="text-xl font-bold tracking-tight text-[#f2f0eb] sm:text-2xl">Dati temporaneamente non disponibili</h1>
			<p class="mt-2 text-sm text-neutral-400 font-mono">
				Le informazioni di stato per questo gruppo sono momentaneamente non disponibili a causa delle quote di lettura del database.
			</p>
		</div>
	{:else}
		<!-- Group Status Banner -->
		<div class="relative mb-10 overflow-hidden rounded-xl border {isOperational ? 'border-white/10 bg-[#121212]' : 'border-[#d4200a]/50 bg-[#160d0d]'} p-8 sm:p-10 shadow-lg">
			<div class="flex items-center justify-between gap-4">
				<div>
					<h1 class="text-2xl font-bold tracking-tight text-[#f2f0eb] sm:text-3xl">{data.group.name}</h1>
					<p class="mt-1 font-mono text-xs {isOperational ? 'text-neutral-400' : 'text-[#d4200a]'}">
						{isOperational ? 'Tutti i monitor di questo gruppo sono operativi' : 'Uno o più monitor riscontrano anomalie'}
					</p>
					{#if data.group.description}
						<p class="mt-3 text-xs font-mono text-neutral-400 max-w-2xl">{data.group.description}</p>
					{/if}
				</div>
				<div class="hidden sm:block">
					<span class="inline-flex items-center gap-2 border border-white/15 bg-white/5 px-3 py-1 font-mono text-xs uppercase tracking-wider text-[#f2f0eb]">
						<span class="inline-block h-[5px] w-[5px] {isOperational ? 'bg-[#d4200a]' : 'bg-[#d4200a] animate-ping'}"></span>
						{isOperational ? 'Operativo' : 'Attenzione'}
					</span>
				</div>
			</div>
		</div>

		<!-- Active Incidents -->
		{#if data.activeIncidents.length > 0}
			<div class="mb-10 space-y-4">
				<h2 class="text-xs font-mono font-semibold uppercase tracking-widest text-neutral-400">Incidenti attivi</h2>
				{#each data.activeIncidents as incident (incident.id)}
					<div class="rounded-xl border border-[#d4200a]/40 bg-[#160d0d] p-5">
						<div class="flex items-center gap-2">
							<span class="inline-block h-[5px] w-[5px] bg-[#d4200a]"></span>
							<h3 class="font-semibold text-[#f2f0eb]">{incident.title}</h3>
						</div>
						{#if incident.updates.length > 0}
							<p class="mt-2 text-sm font-mono text-neutral-300">
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

		<!-- Monitors with Uptime Bars -->
		<div class="mb-10">
			<div class="mb-5 flex items-center justify-between">
				<h2 class="text-xs font-mono font-semibold uppercase tracking-widest text-neutral-400">
					Monitor Attivi
				</h2>
				<p class="text-xs font-mono text-neutral-500">Storico degli ultimi 90 giorni</p>
			</div>

			{#if data.group.monitors.length > 0}
				<div class="space-y-4">
					{#each data.group.monitors as monitor (monitor.id)}
						<UptimeBars
							name={monitor.name}
							days={monitor.daily_status}
							uptimePercent={monitor.uptime_90d}
							currentStatus={monitor.current_status}
						/>
					{/each}
				</div>
			{:else}
				<div class="rounded-xl border border-white/10 bg-[#121212] p-12 text-center text-xs font-mono text-neutral-500">
					Nessun monitor in questo gruppo.
				</div>
			{/if}
		</div>
	{/if}
</PublicLayout>
