<script setup lang="ts">
defineProps<{ title: string; subtitle: string }>();
</script>

<template>
	<div class="auth">
		<div class="auth-intro">
			<p class="eyebrow">Internship research, tracked</p>
			<h1>Five internships worth reviewing, and what changed since last time.</h1>
			<p class="muted">
				Intersearch searches a short list of companies you choose, ranks the best matches, and cites every claim to
				its source.
			</p>
		</div>
		<section class="card auth-card" :aria-label="title">
			<header>
				<h2>{{ title }}</h2>
				<p class="muted">{{ subtitle }}</p>
			</header>
			<slot />
		</section>
	</div>
</template>

<style scoped>
.auth {
	max-width: 960px;
	margin: 0 auto;
	padding: var(--space-7) var(--space-4);
	display: grid;
	grid-template-columns: 1.1fr 1fr;
	gap: var(--space-7);
	align-items: center;
}

.auth-intro {
	display: grid;
	gap: var(--space-3);
}

.auth-intro h1 {
	font-size: 2rem;
	line-height: 1.2;
}

.eyebrow {
	color: var(--accent);
	font-weight: 650;
	font-size: 0.82rem;
	text-transform: uppercase;
	letter-spacing: 0.08em;
}

.auth-card header {
	display: grid;
	gap: 4px;
}

@media (max-width: 800px) {
	.auth {
		grid-template-columns: 1fr;
		gap: var(--space-5);
		padding-top: var(--space-5);
	}

	.auth-intro h1 {
		font-size: 1.5rem;
	}
}
</style>
