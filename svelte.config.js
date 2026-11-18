import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		// Audit 2026-11-18 (SEC-S-06): CSP applicata. SvelteKit aggiunge da se'
		// nonce/hash ai propri script inline. Gli stili inline (attributi style
		// dei componenti) richiedono 'unsafe-inline' su style-src.
		// NB: se si attivano GA4/Clarity (VITE_GA4_ID / VITE_CLARITY_ID) vanno
		// aggiunti i loro domini e i loro script inline vanno spostati in file.
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				'script-src': ['self'],
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'data:'],
				'font-src': ['self'],
				'connect-src': ['self'],
				'object-src': ['none'],
				'base-uri': ['self'],
				'form-action': ['self'],
				'frame-ancestors': ['none'],
				'upgrade-insecure-requests': true
			}
		},
		adapter: adapter({
			config: 'wrangler.build.toml',
			routes: {
				include: ['/*'],
				exclude: ['<all>']
			}
		})
	}
};

export default config;
