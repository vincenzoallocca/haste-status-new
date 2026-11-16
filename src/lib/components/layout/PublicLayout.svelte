<script lang="ts">
	import type { Snippet } from 'svelte';

interface Props {
	children: Snippet;
}

let { children }: Props = $props();
</script>

<div class="min-h-screen bg-[#0a0a0a] text-[#f2f0eb] selection:bg-[#d4200a] selection:text-white">
	<!-- Top Navigation -->
	<div class="border-b border-white/10 bg-[#0a0a0a]/90 backdrop-blur-md sticky top-0 z-40">
		<div class="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
			<!-- Logo & Status -->
			<div class="flex items-center gap-3">
				<a href="https://haste.it" target="_blank" rel="noopener noreferrer" class="flex items-center transition hover:opacity-80">
					<img src="/logo.svg" alt="HASTE" class="h-5 w-auto" />
				</a>
				<div class="h-4 w-px bg-white/15"></div>
				<a href="/status" class="flex items-center gap-2">
					<span class="font-mono text-[11px] font-semibold tracking-[0.22em] uppercase text-neutral-300">
						STATUS
					</span>
					<!-- HASTE signature status dot (5px square red dot from layout.css) -->
					<span class="inline-block h-[5px] w-[5px] bg-[#d4200a]"></span>
				</a>
			</div>

			<!-- Quick Links -->
			<div class="flex items-center gap-4">
				<a
					href="https://haste.it"
					target="_blank"
					rel="noopener noreferrer"
					class="hidden sm:inline-flex items-center gap-1 font-mono text-xs text-neutral-400 hover:text-white transition"
				>
					haste.it <span class="text-[#d4200a]">↗</span>
				</a>
				<a
					href="https://mail.haste.it"
					target="_blank"
					rel="noopener noreferrer"
					class="hidden sm:inline-flex items-center gap-1 font-mono text-xs text-neutral-400 hover:text-white transition"
				>
					mail <span class="text-[#d4200a]">↗</span>
				</a>
				<a
					href="/login"
					class="border border-white/15 bg-white/5 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.16em] text-neutral-300 hover:border-white/40 hover:bg-white/10 hover:text-white transition"
				>
					Staff Login
				</a>
			</div>
		</div>
	</div>

	<!-- Main Body Container -->
	<main class="mx-auto max-w-5xl px-4 py-10 sm:px-6">
		{@render children()}
	</main>

	<!-- Footer -->
	<footer class="mt-20 border-t border-white/10 bg-[#0a0a0a] py-8">
		<div class="mx-auto max-w-5xl px-4 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs font-mono text-neutral-400 sm:px-6">
			<div class="flex items-center gap-2">
				<span class="text-white font-semibold">HASTE Collective</span>
				<span>&copy; {new Date().getFullYear()}</span>
				<span>&middot;</span>
				<span class="text-neutral-400">Cloudflare Edge Runtime</span>
			</div>
			<div class="flex items-center gap-2">
				<span class="inline-block h-[5px] w-[5px] bg-[#d4200a]"></span>
				<span class="text-neutral-400">Controlli ogni 60s</span>
			</div>
		</div>
	</footer>
</div>
