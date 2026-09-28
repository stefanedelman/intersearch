<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ApiError } from "../api/client";
import { formatDateTime, formatDuration, trackerApi, type Report, type RunSummary, type TrackerOverview } from "../api/tracker";
import ReportSections from "../components/ReportSections.vue";
import RunStatusBadge from "../components/RunStatusBadge.vue";
import { useAuth } from "../composables/useAuth";
import { usePolling } from "../composables/usePolling";

const { user, refresh } = useAuth();

const overview = ref<TrackerOverview | null>(null);
const report = ref<Report | null>(null);
const reportRun = ref<RunSummary | null>(null);
const loading = ref(true);
const error = ref("");

const config = computed(() => overview.value?.tracker.config ?? null);
const running = computed(() => overview.value?.runInProgress ?? null);
const latest = computed(() => overview.value?.latestRun ?? null);

async function load() {
	const [nextOverview, latestReport] = await Promise.all([trackerApi.overview(), trackerApi.latestReport()]);
	overview.value = nextOverview;
	report.value = latestReport.report;
	reportRun.value = latestReport.run;
}

const polling = usePolling(load, () => Boolean(running.value));

onMounted(async () => {
	void refresh().catch(() => undefined);
	try {
		await load();
	} catch (err) {
		error.value = err instanceof ApiError ? err.message : "Could not load the tracker.";
	} finally {
		loading.value = false;
		polling.restart();
	}
});
</script>

<template>
	<div class="page">
		<div class="page-header">
			<div>
				<h1>Dashboard</h1>
				<p>Signed in as <strong>{{ user?.username }}</strong></p>
			</div>
			<RouterLink v-if="latest" to="/runs" class="btn btn-secondary">Run history</RouterLink>
		</div>

		<p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>
		<p v-if="loading" class="muted" aria-live="polite">Loading your tracker…</p>

		<template v-else-if="!error">
			<section class="card overview" aria-label="Tracker overview">
				<div class="overview-main">
					<p class="eyebrow">Tracking</p>
					<h2>{{ config?.tracker.topic ?? "No tracker configured yet" }}</h2>
					<p v-if="config" class="muted">
						Top {{ config.tracker.k }} · {{ config.tracker.season.replace("-", " ") }} · {{ config.preferences.locations.join(", ") }}
						<span v-if="config.preferences.remote_allowed"> or remote ({{ config.preferences.remote_region ?? "any" }})</span>
					</p>
					<div v-if="config" class="chips">
						<span v-for="company in config.companies" :key="company.id" class="badge">{{ company.name }}</span>
					</div>
				</div>
				<div class="overview-run">
					<template v-if="running">
						<RunStatusBadge status="running" />
						<p class="muted">Started {{ formatDateTime(running.startedAt) }}. This page refreshes automatically.</p>
					</template>
					<template v-else-if="latest">
						<div class="row">
							<span class="subtle">Latest run</span>
							<RunStatusBadge :status="latest.status" :stale="latest.errorCode === 'abandoned'" />
						</div>
						<p class="muted">{{ formatDateTime(latest.startedAt) }}<span v-if="latest.finishedAt"> · {{ formatDuration(new Date(latest.finishedAt).getTime() - new Date(latest.startedAt).getTime()) }}</span></p>
						<RouterLink :to="`/runs/${latest.id}`">Run details, sources, and trace</RouterLink>
					</template>
					<p class="subtle run-hint">Start a run from your terminal:</p>
					<span class="command">npm run tracker:run</span>
				</div>
			</section>

			<template v-if="report && reportRun">
				<div class="report-meta subtle">
					Report from {{ formatDateTime(report.generatedAt) }} ·
					{{ report.stats.fetched }} fetched, {{ report.stats.skipped }} reused, {{ report.stats.rejected }} rejected ·
					<RouterLink :to="`/runs/${reportRun.id}`">details</RouterLink>
				</div>
				<ReportSections :report="report" />
			</template>

			<section v-else class="card">
				<div class="empty">
					<h2>No tracker runs yet</h2>
					<p>Run the tracker from your terminal. The ranked report appears here when it finishes.</p>
					<span class="command">npm run tracker:run</span>
				</div>
			</section>
		</template>
	</div>
</template>

<style scoped>
.overview {
	grid-template-columns: 1.6fr 1fr;
	align-items: start;
}

.overview-main,
.overview-run {
	display: grid;
	gap: var(--space-2);
	align-content: start;
	min-width: 0;
}

.overview-run {
	border-left: 1px solid var(--border);
	padding-left: var(--space-5);
}

.eyebrow {
	color: var(--accent);
	font-weight: 650;
	font-size: 0.78rem;
	text-transform: uppercase;
	letter-spacing: 0.08em;
}

.chips {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin-top: var(--space-1);
}

.run-hint {
	margin-top: var(--space-2);
}

.command {
	justify-self: start;
}

.report-meta {
	margin-bottom: calc(var(--space-3) * -1);
}

@media (max-width: 760px) {
	.overview {
		grid-template-columns: 1fr;
	}

	.overview-run {
		border-left: none;
		padding-left: 0;
		border-top: 1px solid var(--border);
		padding-top: var(--space-4);
	}
}
</style>
