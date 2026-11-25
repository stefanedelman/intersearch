<script setup lang="ts">
import { computed } from "vue";
import type { Ledger } from "../api/tracker";

// The run's one budget: what the orchestrator has charged (each request once) against the total.
const props = defineProps<{ ledger: Ledger }>();

const rows = computed(() =>
	(["steps", "fetches", "tokens"] as const).map((key) => {
		const total = props.ledger.total[key];
		const used = props.ledger.charged[key];
		return { key, label: key === "steps" ? "Steps" : key === "fetches" ? "Fetches" : "Tokens", used, total, pct: total > 0 ? Math.min(100, (used / total) * 100) : 0 };
	}),
);
</script>

<template>
	<div class="ledger" aria-label="Run budget">
		<div v-for="row in rows" :key="row.key" class="row-bar" :title="`${row.used.toLocaleString()} of ${row.total.toLocaleString()} ${row.label.toLowerCase()} charged`">
			<span class="mono name">{{ row.label }}</span>
			<span class="track"><span class="fill" :style="{ width: `${row.pct}%` }"></span></span>
			<span class="mono value">{{ row.used.toLocaleString() }} / {{ row.total.toLocaleString() }}</span>
		</div>
	</div>
</template>

<style scoped>
.ledger {
	display: grid;
	gap: 8px;
}

.row-bar {
	display: grid;
	grid-template-columns: 64px 1fr auto;
	gap: var(--space-3);
	align-items: center;
}

.name {
	font-size: 10.5px;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: var(--text-subtle);
}

.track {
	height: 6px;
	background: rgba(255, 255, 255, 0.07);
	border-radius: 1px;
	overflow: hidden;
}

.fill {
	display: block;
	height: 100%;
	background: var(--accent);
	transition: width 0.4s ease;
}

.value {
	font-size: 11.5px;
	color: var(--text-muted);
	white-space: nowrap;
}
</style>
