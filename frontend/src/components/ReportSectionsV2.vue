<script setup lang="ts">
import { computed } from "vue";
import { WORKER_TEXT, type ReportV2 } from "../api/tracker";
import DevelopmentCard from "./DevelopmentCard.vue";

// Orchestrated runs (schemaVersion 2): the researcher's top K, each claim labelled by the verifier.
const props = defineProps<{ report: ReportV2 }>();

const newItems = computed(() => props.report.items.filter((item) => item.section === "new"));
const stillItems = computed(() => props.report.items.filter((item) => item.section !== "new"));
const failed = computed(() => props.report.failedWorkers.map((worker) => WORKER_TEXT[worker]).join(" and "));
const staleHeadline = computed(() =>
	props.report.failedWorkers.includes("researcher") ? "No new results this run: the researcher was unavailable." : `No new results this run${props.report.stopReason ? ` (${props.report.stopReason})` : ""}.`,
);
</script>

<template>
	<div class="sections">
		<div v-if="report.stale" :class="['alert', report.items.length ? 'alert-warn' : 'alert-error']" role="status">
			<span>
				<strong>{{ staleHeadline }}</strong>
				{{ report.items.length ? `Showing the previous top ${report.items.length}, marked stale. Nothing below was re-checked.` : "There is no earlier run to show instead." }}
			</span>
		</div>
		<div v-else-if="report.status !== 'complete'" :class="['alert', report.status === 'failed' ? 'alert-error' : 'alert-warn']" role="status">
			<span>
				<strong>{{ report.status === "failed" ? "This run failed." : "This report is partial." }}</strong>
				{{ report.failedWorkers.includes("verifier") ? "The verifier failed, so some claims are marked Unverified." : "" }}
				<span v-if="report.stopReason" class="reason">Reason: {{ report.stopReason }}</span>
			</span>
		</div>
		<p v-if="failed && !report.stale" class="subtle failed-line">Failed worker: {{ failed }}</p>
		<p v-if="report.comparison.note" class="alert alert-info">{{ report.comparison.note }}</p>

		<section v-if="report.stale" class="stack" aria-labelledby="sec-stale">
			<div class="section-title">
				<h2 id="sec-stale">Previous top {{ report.k }} (stale)</h2>
				<span class="count">{{ report.items.length }}</span>
			</div>
			<DevelopmentCard v-for="item in report.items" :key="item.developmentId" :item="item" />
			<p v-if="!report.items.length" class="card card-compact muted">There is no earlier run to fall back on.</p>
		</section>

		<template v-else>
			<section class="stack" aria-labelledby="sec-new">
				<div class="section-title">
					<h2 id="sec-new">New since last run</h2>
					<span class="count">{{ newItems.length }}</span>
				</div>
				<DevelopmentCard v-for="item in newItems" :key="item.developmentId" :item="item" />
				<p v-if="!newItems.length" class="card card-compact muted">No new developments since the last run.</p>
			</section>

			<section class="stack" aria-labelledby="sec-still">
				<div class="section-title">
					<h2 id="sec-still">Still in top {{ report.k }}</h2>
					<span class="count">{{ stillItems.length }}</span>
				</div>
				<DevelopmentCard v-for="item in stillItems" :key="item.developmentId" :item="item" />
				<p v-if="!stillItems.length" class="card card-compact muted">Nothing carried over from the last run.</p>
			</section>

			<section class="stack" aria-labelledby="sec-dropped">
				<div class="section-title">
					<h2 id="sec-dropped">Dropped</h2>
					<span class="count">{{ report.dropped.length }}</span>
				</div>
				<ul v-if="report.dropped.length" class="card card-compact dropped">
					<li v-for="item in report.dropped" :key="item.developmentId">
						<div class="dropped-head">
							<span class="dropped-title">{{ item.title }}</span>
							<span v-if="item.previousRank" class="mono prev">was #{{ item.previousRank }}</span>
						</div>
						<p class="subtle">{{ item.reason }}</p>
					</li>
				</ul>
				<p v-else class="card card-compact muted">Nothing dropped out of the top {{ report.k }}.</p>
			</section>
		</template>

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

.sections > .alert,
.failed-line {
	margin-bottom: calc(var(--space-7) * -1 + var(--space-3));
}

.reason {
	display: block;
	margin-top: 4px;
	font-size: 13px;
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
