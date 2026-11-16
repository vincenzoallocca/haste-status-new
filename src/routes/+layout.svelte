<script lang="ts">
	import '../app.css';
	import { pwaInfo } from 'virtual:pwa-info';
	import ReloadPrompt from '$lib/components/ReloadPrompt.svelte';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" type="image/x-icon" href="/favicon.ico" />
	<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
	<link rel="apple-touch-icon" href="/icon-192.png" />
	{#if pwaInfo}
		<link rel="manifest" href={pwaInfo.webManifest.href} />
	{/if}

	<!-- Google Analytics (GA4) -->
	{#if import.meta.env.VITE_GA4_ID}
		<script async src="https://www.googletagmanager.com/gtag/js?id={import.meta.env.VITE_GA4_ID}"></script>
		<script>
			window.dataLayer = window.dataLayer || [];
			function gtag(){dataLayer.push(arguments);}
			gtag('js', new Date());
			gtag('config', '{import.meta.env.VITE_GA4_ID}');
		</script>
	{/if}

	<!-- Microsoft Clarity -->
	{#if import.meta.env.VITE_CLARITY_ID}
		<script type="text/javascript">
			(function(c,l,a,r,i,t,y){
				c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
				t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
				y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
			})(window, document, "clarity", "script", "{import.meta.env.VITE_CLARITY_ID}");
		</script>
	{/if}

	<!-- Meta Pixel (Facebook) -->
	{#if import.meta.env.VITE_META_PIXEL_ID}
		<script>
			!function(f,b,e,v,n,t,s)
			{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
			n.callMethod.apply(n,arguments):n.queue.push(arguments)};
			if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
			n.queue=[];t=b.createElement(e);t.async=!0;
			t.src=v;s=b.getElementsByTagName(e)[0];
			s.parentNode.insertBefore(t,s)}(window, document,'script',
			'https://connect.facebook.net/en_US/fbevents.js');
			fbq('init', '{import.meta.env.VITE_META_PIXEL_ID}');
			fbq('track', 'PageView');
		</script>
		<noscript>
			<img height="1" width="1" style="display:none" alt=""
			src="https://www.facebook.com/tr?id={import.meta.env.VITE_META_PIXEL_ID}&ev=PageView&noscript=1"/>
		</noscript>
	{/if}
</svelte:head>

{@render children()}
<ReloadPrompt />
