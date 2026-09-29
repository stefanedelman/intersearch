<script setup lang="ts">
import { computed } from "vue";
import type { Report } from "../api/tracker";
import OpportunityCard from "./OpportunityCard.vue";

const props = defineProps<{ report: Report }>();

const newItems = computed(() => props.report.items.filter((item) => item.section === "new"));
const stillItems = computed(() => props.report.items.filter((item) => item.section !== "new"));
</script>

<template>
	<div class="sections">
		<div v-if="report.status !== 'complete'" :class="['alert', report.status === 'failed' ? 'alert-error' : 'alert-warn']" role="status">
			<span>
				<strong>{{ report.status === "failed" ? "This run failed." : "This report is partial." }}</strong>
				It uses only the evidence gathered before the run stopped<span v-if="report.stopReason">: {{ report.stopReason }}</span>.
			</span>
		</div>
		<p v-if="report.comparison.note" class="alert alert-info">{{ report.comparison.note }}</p>

		<section class="stack" aria-labelledby="sec-new">
			<div class="section-title">
				<h2 id="sec-new">New since last run</h2>
				<span class="count">{{ newItems.length }}</span>
			</div>
			<OpportunityCard v-for="item in newItems" :key="item.identityKey" :item="item" />
			<p v-if="!newItems.length" class="card card-compact muted">No new developments since the last run.</p>
		</section>

		<section class="stack" aria-labelledby="sec-still">
			<div class="section-title">
				<h2 id="sec-still">Still in top {{ report.k }}</h2>
				<span class="count">{{ stillItems.length }}</span>
			</div>
			<OpportunityCard v-for="item in stillItems" :key="item.identityKey" :item="item" />
			<p v-if="!stillItems.length" class="card card-compact muted">Nothing carried over from the last run.</p>
		</section>

		<section class="stack" aria-labelledby="sec-dropped">
			<div class="section-title">
				<h2 id="sec-dropped">Dropped</h2>
				<span class="count">{{ report.dropped.length }}</span>
			</div>
			<ul v-if="report.dropped.length" class="card card-compact dropped">
				<li v-for="item in report.dropped" :key="item.identityKey">
					<div class="dropped-head">
						<span class="dropped-title">{{ item.title }}</span>
						<span class="muted">{{ item.company ?? "Unknown company" }}</span>
						<span v-if="item.previousRank" class="mono prev">was #{{ item.previousRank }}</span>
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
.sections {
	display: grid;
	gap: var(--space-7);
}

.sections > .alert {
	margin-bottom: calc(var(--space-7) * -1 + var(--space-3));
}

.dropped {
	list-style: none;
	margin: 0;
	gap: 0;
	padding-top: var(--space-2);
	padding-bottom: var(--space-2);
}

.dropped li {
	display: grid;
	gap: 4px;
	padding: var(--space-3) 0;
	border-bottom: 1px solid var(--border);
}

.dropped li:last-child {
	border-bottom: none;
}

.dropped-head {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 4px 10px;
	font-size: 14px;
}

.dropped-title {
	font-weight: 500;
}

.prev {
	font-size: 11px;
	color: var(--text-subtle);
}

.notes {
	margin: 0;
	padding-left: 1.1rem;
	display: grid;
	gap: 4px;
}
</style>
