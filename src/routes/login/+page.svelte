<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	let email = $state('');
	let password = $state('');
	let error = $state('');
	let isSubmitting = $state(false);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		error = '';

		if (!email || !password) {
			error = 'Email e password sono obbligatorie';
			return;
		}

		isSubmitting = true;

		try {
			const response = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password })
			});

			const data = (await response.json()) as { error?: string };

			if (!response.ok) {
				error = data.error || 'Autenticazione fallita';
				return;
			}

			await goto(resolve('/'));
		} catch {
			error = 'Si è verificato un errore di connessione. Riprova.';
		} finally {
			isSubmitting = false;
		}
	}
</script>

<svelte:head>
	<title>Staff Login — HASTE Status</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center bg-[#0a0a0a] px-4 py-12 text-[#f2f0eb]">
	<div class="w-full max-w-md">
		<!-- Header with HASTE logo -->
		<div class="text-center">
			<a href="https://haste.it" target="_blank" rel="noopener noreferrer" class="inline-block transition hover:opacity-85">
				<img src="/logo.svg" alt="HASTE" class="mx-auto h-8 w-auto" />
			</a>
			<h1 class="mt-6 text-xl font-bold tracking-tight text-white">HASTE Status Portal</h1>
			<p class="mt-1 font-mono text-xs text-neutral-400">Accesso amministrazione e monitoraggio</p>
		</div>

		<!-- Login Card -->
		<div class="mt-8 rounded-2xl border border-white/10 bg-[#121212] p-8 shadow-2xl">
			{#if error}
				<div class="mb-5 rounded-lg border border-[#d4200a]/40 bg-[#1e0e0e] p-3 text-xs font-mono text-red-300">
					{error}
				</div>
			{/if}

			<form onsubmit={handleSubmit} class="space-y-5">
				<div>
					<label for="email" class="block font-mono text-xs font-medium uppercase tracking-wider text-neutral-400">
						Email
					</label>
					<input
						type="email"
						id="email"
						name="email"
						placeholder="admin@haste.it"
						bind:value={email}
						required
						class="mt-1.5 w-full rounded-lg border border-white/15 bg-[#181818] px-3.5 py-2.5 font-mono text-sm text-white placeholder-neutral-500 transition focus:border-[#d4200a] focus:outline-none focus:ring-1 focus:ring-[#d4200a]"
					/>
				</div>

				<div>
					<label for="password" class="block font-mono text-xs font-medium uppercase tracking-wider text-neutral-400">
						Password
					</label>
					<input
						type="password"
						id="password"
						name="password"
						placeholder="••••••••••••"
						bind:value={password}
						required
						class="mt-1.5 w-full rounded-lg border border-white/15 bg-[#181818] px-3.5 py-2.5 font-mono text-sm text-white placeholder-neutral-500 transition focus:border-[#d4200a] focus:outline-none focus:ring-1 focus:ring-[#d4200a]"
					/>
				</div>

				<button
					type="submit"
					disabled={isSubmitting}
					class="w-full rounded-lg bg-[#d4200a] py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-white shadow-lg transition hover:bg-[#b01a07] disabled:opacity-50"
				>
					{isSubmitting ? 'Accesso in corso...' : 'Accedi al Pannello'}
				</button>
			</form>
		</div>

		<!-- Back Link -->
		<div class="mt-6 text-center">
			<a href="/status" class="font-mono text-xs text-neutral-500 hover:text-white transition">
				&larr; Torna alla Status Page Pubblica
			</a>
		</div>
	</div>
</div>
