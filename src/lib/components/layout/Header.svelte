<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import type { UserPublic } from '$lib/types/auth';

	let { user = undefined }: { user?: UserPublic | null } = $props();

	let loggingOut = $state(false);

	async function handleLogout() {
		loggingOut = true;
		try {
			await fetch('/api/auth/logout', { method: 'POST' });
			await goto('/login');
		} finally {
			loggingOut = false;
		}
	}

	interface NavItem {
		href: string;
		label: string;
		match: (path: string) => boolean;
	}

	const navItems: NavItem[] = [
		{ href: '/', label: 'Dashboard', match: (path) => path === '/' },
		{
			href: '/admin/status',
			label: 'Status Page',
			match: (path) => path.startsWith('/admin/status') || path.startsWith('/announcements')
		},
		{
			href: '/notifications',
			label: 'Notifiche',
			match: (path) => path.startsWith('/notifications')
		},
		{ href: '/settings', label: 'Impostazioni', match: (path) => path.startsWith('/settings') }
	];

	const currentPath = $derived($page.url.pathname);
</script>

<header class="hidden border-b border-white/10 bg-[#0e0e0e] md:block sticky top-0 z-40">
	<div class="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
		<div class="flex items-center gap-8">
			<a href="/" class="flex items-center gap-3">
				<img src="/logo.svg" alt="HASTE" class="h-6 w-auto" />
				<div class="h-4 w-px bg-white/10"></div>
				<span class="font-mono text-xs font-bold uppercase tracking-widest text-neutral-300">
					Admin
				</span>
			</a>

			<nav class="flex items-center gap-1 font-mono text-xs">
				{#each navItems as item (item.href)}
					{@const isActive = item.match(currentPath)}
					<a
						href={item.href}
						class="rounded-md px-3 py-1.5 transition-colors {isActive
							? 'bg-neutral-800 text-white font-semibold'
							: 'text-neutral-400 hover:bg-neutral-900 hover:text-white'}"
						aria-current={isActive ? 'page' : undefined}
					>
						{item.label}
					</a>
				{/each}
			</nav>
		</div>

		<div class="flex items-center gap-4 font-mono text-xs">
			<a
				href="/status"
				target="_blank"
				class="text-neutral-400 hover:text-white transition flex items-center gap-1"
			>
				Vedi Status Pubblico <span class="text-[#d4200a]">↗</span>
			</a>

			{#if user}
				<div class="h-4 w-px bg-white/10"></div>
				<span class="text-neutral-300 font-semibold">{user.name}</span>
				<button
					type="button"
					onclick={handleLogout}
					disabled={loggingOut}
					class="rounded-md border border-white/10 px-2.5 py-1 text-neutral-400 transition hover:border-[#d4200a]/50 hover:bg-[#d4200a]/10 hover:text-red-400 disabled:opacity-50"
				>
					{loggingOut ? 'Uscita...' : 'Esci'}
				</button>
			{/if}
		</div>
	</div>
</header>
