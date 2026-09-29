<script setup lang="ts">
import BrandMark from "./BrandMark.vue";

defineProps<{ title: string; subtitle: string }>();
</script>

<template>
	<div class="auth">
		<div class="grid-bg" aria-hidden="true"></div>

		<section class="hero">
			<RouterLink to="/login" class="brand" aria-label="Intersearch">
				<BrandMark />
				<span>Intersearch</span>
			</RouterLink>
			<span class="pill">
				<span class="pill-dot" aria-hidden="true"></span>
				Summer 2027 · 5 companies · cited sources
			</span>
			<h1 class="display hero-title">Internships<br />worth your time</h1>
			<p class="lead">
				A research agent reads the job boards, ranks the five best matches, quotes every claim from the source, and
				tells you what changed since the last run.
			</p>
		</section>

		<section class="card panel" :aria-label="title">
			<header class="panel-head">
				<h2>{{ title }}</h2>
				<p class="muted">{{ subtitle }}</p>
			</header>
			<slot />
		</section>
	</div>
</template>

<style scoped>
.auth {
	position: relative;
	min-height: 100vh;
	max-width: 1120px;
	margin: 0 auto;
	padding: var(--space-8) var(--space-6);
	display: grid;
	grid-template-columns: 1.15fr 1fr;
	gap: var(--space-8);
	align-items: center;
}

/* Faint grid that fades out, for depth behind the hero. */
.grid-bg {
	position: fixed;
	inset: 0;
	z-index: -1;
	pointer-events: none;
	background-image: linear-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255, 255, 255, 0.04) 1px, transparent 1px);
	background-size: 56px 56px;
	mask-image: radial-gradient(ellipse 70% 55% at 30% 35%, #000 20%, transparent 75%);
}

.hero {
	display: grid;
	gap: var(--space-5);
	justify-items: start;
}

.brand {
	display: inline-flex;
	align-items: center;
	gap: 10px;
	font-weight: 600;
	font-size: 15px;
	color: var(--text);
	text-decoration: none;
}

/* Glowing multicolor outline, like Resend's announcement pill. */
.pill {
	position: relative;
	display: inline-flex;
	align-items: center;
	gap: 8px;
	height: 30px;
	padding: 0 14px;
	border-radius: var(--radius-pill);
	font-size: 12.5px;
	color: var(--text-muted);
	background: rgba(0, 0, 0, 0.6);
}

.pill::before {
	content: "";
	position: absolute;
	inset: -1px;
	border-radius: inherit;
	padding: 1px;
	background: linear-gradient(90deg, rgba(94, 240, 161, 0.7), rgba(124, 180, 255, 0.7), rgba(185, 166, 255, 0.8), rgba(255, 179, 92, 0.6));
	-webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
	-webkit-mask-composite: xor;
	mask-composite: exclude;
}

.pill::after {
	content: "";
	position: absolute;
	inset: 4px 10%;
	z-index: -1;
	filter: blur(14px);
	background: linear-gradient(90deg, rgba(94, 240, 161, 0.35), rgba(124, 180, 255, 0.35), rgba(185, 166, 255, 0.35));
}

.pill-dot {
	width: 6px;
	height: 6px;
	border-radius: 50%;
	background: var(--green);
	box-shadow: 0 0 10px var(--green);
}

.hero-title {
	font-size: clamp(3rem, 6.4vw, 5rem);
}

.lead {
	font-size: 17px;
	max-width: 44ch;
}

.panel {
	padding: var(--space-6);
	gap: var(--space-5);
	background: linear-gradient(180deg, rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.015));
	border-color: var(--border-strong);
	box-shadow: 0 30px 80px -30px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.panel-head {
	display: grid;
	gap: 6px;
}

.panel-head h2 {
	font-size: 20px;
	font-weight: 600;
	letter-spacing: -0.015em;
}

@media (max-width: 880px) {
	.auth {
		grid-template-columns: 1fr;
		gap: var(--space-6);
		padding: var(--space-6) var(--space-4) var(--space-7);
		min-height: auto;
	}

	.hero-title {
		font-size: 3rem;
	}

	.lead {
		font-size: 15px;
	}

	.panel {
		padding: var(--space-5);
	}
}
</style>
