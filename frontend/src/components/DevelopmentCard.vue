<script setup lang="ts">
import { computed } from "vue";
import { CLAIM_LABELS, CLAIM_LABEL_TEXT, type ReportItemV2 } from "../api/tracker";
import ClaimList from "./ClaimList.vue";

// A ranked development from an orchestrated run. Every string came from the web via the
// researcher; it is rendered as text only.
const props = defineProps<{ item: ReportItemV2 }>();

const sectionLabel = computed(() => ({ new: "New", still: "Still in top K", returned: "Returned" })[props.item.section]);
const rank = computed(() => String(props.item.rank).padStart(2, "0"));
const counts = computed(() => CLAIM_LABELS.map((label) => ({ label, count: props.item.claims.filter((claim) => claim.label === label).length })).filter((entry) => entry.count > 0));
</script>

<template>
	<article :class="['card', 'development', `development-${item.section}`, { stale: item.stale }]">
		<div v-if="item.stale" class="ribbon mono">Stale · from run {{ item.fromRunId?.slice(0, 8) }}</div>
		<header class="head">
			<span class="rank mono" :aria-label="`Rank ${item.rank}`">{{ rank }}</span>
			<div class="titles">
				<div class="row tags">
					<span v-if="!item.stale" :class="['badge', `badge-${item.section}`]">{{ sectionLabel }}</span>
					<span v-for="entry in counts" :key="entry.label" :class="['mini', `mini-${entry.label}`]">{{ entry.count }} {{ CLAIM_LABEL_TEXT[entry.label].toLowerCase() }}</span>
				</div>
				<h3>{{ item.title }}</h3>
			</div>
		</header>
		<p v-if="item.summary" class="summary">{{ item.summary }}</p>
		<ClaimList v-if="item.claims.length" :claims="item.claims" />
		<p v-else class="subtle">No claims: this result comes from an earlier tracker run, before claims were verified.</p>
	</article>
</template>

<style scoped>
.development {
	position: relative;
	gap: var(--space-4);
	border-left: 3px solid var(--blue);
}

.development-new {
	border-left-color: #b9e9b0;
}

.development-returned {
	border-left-color: var(--pink);
}

.development.stale {
	border-left-color: var(--orange);
	background: repeating-linear-gradient(135deg, rgba(255, 179, 92, 0.025) 0 12px, transparent 12px 24px), var(--surface);
}

.ribbon {
	justify-self: start;
	padding: 3px 10px;
	border: 1px solid rgba(255, 170, 60, 0.35);
	background: var(--orange-soft);
	color: var(--orange);
	font-size: 10.5px;
	letter-spacing: 0.06em;
	text-transform: uppercase;
}

.head {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: var(--space-4);
	align-items: start;
}

.rank {
	display: grid;
	place-items: center;
	font-size: 13px;
	color: var(--accent);
	width: 32px;
	height: 34px;
	background: var(--accent-soft);
	border: 1px solid rgba(245, 220, 82, 0.3);
	box-shadow: 2px 2px 0 #000;
}

.titles {
	display: grid;
	gap: 8px;
	min-width: 0;
}

.tags {
	gap: 6px;
	flex-wrap: wrap;
}

.titles h3 {
	font-size: 19px;
	font-weight: 600;
	letter-spacing: -0.015em;
	overflow-wrap: anywhere;
}

.mini {
	font-family: var(--font-mono);
	font-size: 10.5px;
	color: var(--text-subtle);
}

.mini-supported {
	color: var(--green);
}

.mini-unsupported {
	color: var(--red);
}

.mini-unverified {
	color: var(--orange);
}

.summary {
	font-size: 14.5px;
	line-height: 1.65;
	color: #d6d8d9;
}
</style>
