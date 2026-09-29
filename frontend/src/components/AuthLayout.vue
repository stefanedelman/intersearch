<script setup lang="ts">
import BrandMark from "./BrandMark.vue";

defineProps<{ title: string; subtitle: string }>();
</script>

<template>
	<div class="auth">
		<div class="grid-bg" aria-hidden="true"></div>
		<header class="auth-top">
			<RouterLink to="/login" class="brand" aria-label="Intersearch">
				<BrandMark />
				<span>Intersearch<span class="brand-period">.</span></span>
			</RouterLink>
			<span class="eyebrow edition">An independent internship tracker</span>
		</header>

		<section class="hero">
			<span class="stamp hero-stamp"><span aria-hidden="true">✳</span> Less searching. More finding.</span>
			<h1 class="headline hero-title">Find your<br /><em>next move.</em></h1>
			<p class="lead">Internships worth your time. A research agent reads the job boards, ranks the best matches, and shows you what changed.</p>
			<div class="hero-notes" aria-label="How Intersearch works">
				<span><b>01</b> Discover</span><span><b>02</b> Rank</span><span><b>03</b> Verify</span>
			</div>
			<div class="research-note">
				<span class="note-symbol" aria-hidden="true">↗</span>
				<div><span class="eyebrow">Follow the evidence</span><p>Every match has a source.<br />Every new run tells a story.</p></div>
				<span class="note-star" aria-hidden="true">✳</span>
			</div>
		</section>

		<section class="card panel" :aria-label="title">
			<div class="panel-label"><span class="eyebrow">Your research desk</span><span aria-hidden="true">↙</span></div>
			<header class="panel-head">
				<h2>{{ title }}</h2>
				<p class="muted">{{ subtitle }}</p>
			</header>
			<slot />
			<div class="panel-bottom"><span class="status-dot" aria-hidden="true"></span> Source-backed. Built for your next step.</div>
		</section>

		<footer class="auth-bottom"><span>INTERSEARCH / PERSONAL RESEARCH</span><span>Find the signal in the listings.</span></footer>
	</div>
</template>

<style scoped>
.auth {
	position: relative;
	min-height: 100vh;
	max-width: 1240px;
	margin: 0 auto;
	padding: 36px 48px 24px;
	display: grid;
	grid-template-columns: 1.2fr 1fr;
	grid-template-rows: auto 1fr auto;
	gap: 60px 80px;
	align-items: center;
}
.grid-bg {
	position: fixed;
	inset: 0;
	z-index: -1;
	pointer-events: none;
	background-image: linear-gradient(rgba(245, 220, 82, 0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(245, 220, 82, 0.035) 1px, transparent 1px);
	background-size: 64px 64px;
	mask-image: radial-gradient(ellipse 70% 70% at 25% 45%, #000 20%, transparent 90%);
}
.auth-top, .auth-bottom {
	grid-column: 1 / -1;
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 16px;
}
.auth-top {
	padding-bottom: 24px;
	border-bottom: 1px solid var(--border);
}
.brand {
	display: inline-flex;
	align-items: center;
	gap: 10px;
	font-weight: 700;
	font-size: 20px;
	text-decoration: none;
	letter-spacing: -0.04em;
}
.brand-period {
	color: var(--accent);
}
.hero {
	display: grid;
	gap: 26px;
	justify-items: start;
	padding-bottom: 12px;
}
.hero-stamp {
	color: var(--accent);
	background: var(--accent-soft);
	border-color: rgba(245, 220, 82, 0.35);
	transform: rotate(-2deg);
}
.hero-stamp > span {
	font-size: 16px;
	line-height: 1;
}
.hero-title {
	font-size: clamp(3.5rem, 6.4vw, 5.7rem);
}
.lead {
	font-size: 16px;
	max-width: 40ch;
}
.hero-notes {
	display: flex;
	flex-wrap: wrap;
	gap: 20px;
	font-family: var(--font-mono);
	font-size: 10px;
	text-transform: uppercase;
	letter-spacing: 0.04em;
}
.hero-notes b {
	color: var(--accent);
	margin-right: 5px;
	font-weight: 400;
}
.research-note {
	display: flex;
	align-items: center;
	gap: 18px;
	width: 100%;
	max-width: 410px;
	border-top: 1px solid var(--border);
	padding-top: 24px;
	margin-top: 8px;
}
.note-symbol {
	color: var(--accent);
	font-size: 40px;
	line-height: 1;
}
.research-note p {
	font-family: var(--font-display);
	font-size: 22px;
	line-height: 1.2;
	margin-top: 6px;
}
.note-star {
	color: var(--pink);
	font-size: 52px;
	line-height: 1;
	margin-left: auto;
	transform: rotate(15deg);
}
.panel {
	position: relative;
	padding: 32px;
	gap: 26px;
	background: linear-gradient(135deg, #1b1c17, #10110f 80%);
	border-color: var(--border-strong);
	box-shadow: 8px 8px 0 var(--bg), 9px 9px 0 rgba(245, 220, 82, 0.38);
}
.panel-label {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding-bottom: 16px;
	border-bottom: 1px solid var(--border);
}
.panel-label > span:last-child {
	font-size: 24px;
	color: var(--accent);
	line-height: 1;
}
.panel-label .eyebrow {
	color: var(--accent);
}
.panel-head {
	display: grid;
	gap: 8px;
}
.panel-head h2 {
	font-family: var(--font-display);
	font-size: 38px;
	font-weight: 400;
}
.panel-bottom {
	display: flex;
	align-items: center;
	gap: 8px;
	padding-top: 18px;
	border-top: 1px dashed var(--border);
	font-family: var(--font-mono);
	font-size: 9px;
	color: var(--text-subtle);
}
.status-dot {
	width: 5px;
	height: 5px;
	flex: none;
	border-radius: 50%;
	background: #b9e9b0;
}
.auth-bottom {
	padding-top: 20px;
	border-top: 1px solid var(--border);
	font-family: var(--font-mono);
	font-size: 9px;
	color: var(--text-subtle);
	letter-spacing: 0.04em;
}
@media (max-width: 1000px) { .auth { padding: 28px 32px; gap: 48px 40px; } .hero-title { font-size: 4rem; } .edition { font-size: 9px; } }
@media (max-width: 760px) {
	.auth {
		grid-template-columns: minmax(0, 1fr);
		gap: 36px;
		padding: 24px;
	}
	.auth-top, .auth-bottom {
		grid-column: 1;
	}
	.edition {
		display: none;
	}
	.hero {
		gap: 22px;
	}
	.hero-title {
		font-size: clamp(3.2rem, 12vw, 5rem);
	}
	.research-note {
		display: none;
	}
	.panel {
		padding: 24px;
	}
	.auth-bottom {
		flex-wrap: wrap;
	}
}
</style>
