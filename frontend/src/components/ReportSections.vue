<script setup lang="ts">
import { computed } from "vue";
import type { Report } from "../api/tracker";
import OpportunityCard from "./OpportunityCard.vue";

const props = defineProps<{ report: Report }>();

const newItems = computed(() => props.report.items.filter((item) => item.section === "new"));
const stillItems = computed(() => props.report.items.filter((item) => item.section !== "new"));
</script>

<template>
	<div class="stack">
		<div v-if="report.status !== 'complete'" :class="['alert', report.status === 'failed' ? 'alert-error' : 'alert-warn']" role="status">
			<strong>{{ report.status === "failed" ? "This run failed." : "This report is partial." }}</strong>
			It uses only the evidence gathered before the run stopped<span v-if="report.stopReason">: {{ report.stopReason }}</span>.
		</div>
		<p v-if="report.comparison.note" class="alert alert-info">{{ report.comparison.note }}</p>

		<section class="stack" aria-labelledby="sec-new">
			<div class="section-head">
				<h2 id="sec-new">New since last run</h2>
				<span class="badge badge-new">{{ newItems.length }}</span>
			</div>
			<OpportunityCard v-for="item in newItems" :key="item.identityKey" :item="item" />
			<p v-if="!newItems.length" class="card card-compact muted">No new developments since the last run.</p>
		</section>

		<section class="stack" aria-labelledby="sec-still">
			<div class="section-head">
				<h2 id="sec-still">Still in top {{ report.k }}</h2>
				<span class="badge badge-still">{{ stillItems.length }}</span>
			</div>
			<OpportunityCard v-for="item in stillItems" :key="item.identityKey" :item="item" />
			<p v-if="!stillItems.length" class="card card-compact muted">Nothing carried over from the last run.</p>
		</section>

		<section class="stack" aria-labelledby="sec-dropped">
			<div class="section-head">
				<h2 id="sec-dropped">Dropped</h2>
				<span class="badge">{{ report.dropped.length }}</span>
			</div>
			<ul v-if="report.dropped.length" class="card card-compact dropped">
				<li v-for="item in report.dropped" :key="item.identityKey">
					<div>
						<strong>{{ item.title }}</strong>
						<span class="muted"> · {{ item.company ?? "Unknown company" }}</span>
						<span v-if="item.previousRank" class="subtle"> (was #{{ item.previousRank }})</span>
					</div>
					<p class="subtle">{{ item.reason }}</p>
				</li>
			</ul>
			<p v-else class="card card-compact muted">Nothing dropped out of the top {{ report.k }}.</p>
		</section>

		<ul v-if="report.notes.length" class="notes subtle">
			<li v-for="note in report.notes" :key="note">{{ note }}</li>
		</ul>
	</div>
</template>

<style scoped>
.section-head {
	display: flex;
	align-items: center;
	gap: var(--space-2);
	margin-top: var(--space-2);
}

.dropped {
	list-style: none;
	margin: 0;
	gap: var(--space-3);
}

.dropped li {
	display: grid;
	gap: 2px;
	padding-bottom: var(--space-3);
	border-bottom: 1px solid var(--border);
}

.dropped li:last-child {
	border-bottom: none;
	padding-bottom: 0;
}

.notes {
	margin: 0;
	padding-left: 1.1rem;
}
</style>
