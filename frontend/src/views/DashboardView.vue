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

const stats = computed(() => {
	if (!report.value) return [];
	const s = report.value.stats;
	return [
		{ label: "Ranked", value: report.value.items.length },
		{ label: "New", value: report.value.items.filter((item) => item.section === "new").length },
		{ label: "Pages fetched", value: s.fetched },
		{ label: "Reused", value: s.skipped },
		{ label: "Blocked", value: s.rejected },
	];
});

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
		<header class="page-header">
			<div>
				<p class="eyebrow">Signed in as {{ user?.username }}</p>
				<h1 class="display">Dashboard</h1>
				<p v-if="config" class="lead">{{ config.tracker.topic }}</p>
			</div>
			<RouterLink v-if="latest" to="/runs" class="btn btn-secondary">Run history</RouterLink>
		</header>

		<p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>

		<div v-if="loading" class="stack" aria-live="polite" aria-label="Loading your tracker">
			<div class="skeleton" style="height: 150px"></div>
			<div class="skeleton" style="height: 260px"></div>
		</div>

		<template v-else-if="!error">
			<section class="overview" aria-label="Tracker overview">
				<div class="card overview-target">
					<span class="eyebrow">Tracking</span>
					<dl v-if="config" class="facts">
						<div>
							<dt class="mono">Top</dt>
							<dd>{{ config.tracker.k }}</dd>
						</div>
						<div>
							<dt class="mono">Season</dt>
							<dd>{{ config.tracker.season.replace("-", " ") }}</dd>
						</div>
						<div>
							<dt class="mono">Where</dt>
							<dd>
								{{ config.preferences.locations.join(", ") }}<span v-if="config.preferences.remote_allowed"> or remote</span>
							</dd>
						</div>
					</dl>
					<p v-else class="muted">No tracker configured yet. The first run imports <code>config.yaml</code>.</p>
					<div v-if="config" class="chips">
						<span v-for="company in config.companies" :key="company.id" class="chip">{{ company.name }}</span>
					</div>
				</div>

				<div class="card overview-run">
					<div class="row between">
						<span class="eyebrow">{{ running ? "Now" : "Latest run" }}</span>
						<RunStatusBadge v-if="running" status="running" />
						<RunStatusBadge v-else-if="latest" :status="latest.status" :stale="latest.errorCode === 'abandoned'" />
					</div>
					<template v-if="running">
						<p class="muted">Started {{ formatDateTime(running.startedAt) }}. This page refreshes automatically.</p>
					</template>
					<template v-else-if="latest">
						<p class="run-when">{{ formatDateTime(latest.startedAt) }}</p>
						<p class="subtle" v-if="latest.finishedAt">Took {{ formatDuration(new Date(latest.finishedAt).getTime() - new Date(latest.startedAt).getTime()) }}</p>
						<RouterLink :to="`/runs/${latest.id}`" class="subtle">Details, sources, and trace →</RouterLink>
					</template>
					<p v-else class="muted">No runs yet.</p>
					<div class="run-cmd">
						<span class="command">npm run tracker:run</span>
					</div>
				</div>
			</section>

			<template v-if="report && reportRun">
				<div class="stats" aria-label="Latest report at a glance">
					<div v-for="stat in stats" :key="stat.label" class="stat">
						<span class="stat-value">{{ stat.value }}</span>
						<span class="eyebrow">{{ stat.label }}</span>
					</div>
				</div>
				<ReportSections :report="report" />
			</template>

			<section v-else class="card">
				<div class="empty">
					<span class="eyebrow">Nothing here yet</span>
					<h2>Run the tracker</h2>
					<p>Start a run from your terminal. The ranked report appears here when it finishes.</p>
					<span class="command">npm run tracker:run</span>
				</div>
			</section>
		</template>
	</div>
</template>

<style scoped>
.page-header .eyebrow {
	margin-bottom: var(--space-3);
}

.overview {
	display: grid;
	grid-template-columns: 1.5fr 1fr;
	gap: var(--space-4);
}

.overview-target,
.overview-run {
	align-content: start;
	gap: var(--space-4);
}

.facts {
	display: grid;
	grid-template-columns: repeat(3, auto);
	justify-content: start;
	gap: var(--space-6);
	margin: 0;
}

.facts div {
	display: grid;
	gap: 4px;
}

.facts dt {
	font-size: 11px;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--text-subtle);
}

.facts dd {
	margin: 0;
	font-size: 15px;
	font-weight: 500;
	text-transform: capitalize;
}

.chips {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}

.chip {
	display: inline-flex;
	align-items: center;
	height: 26px;
	padding: 0 11px;
	border-radius: var(--radius-pill);
	border: 1px solid var(--border);
	background: rgba(255, 255, 255, 0.02);
	font-size: 12.5px;
	color: var(--text-muted);
}

.between {
	justify-content: space-between;
}

.run-when {
	font-size: 15px;
	font-weight: 500;
}

.run-cmd {
	margin-top: auto;
	padding-top: var(--space-2);
}

.stats {
	display: grid;
	grid-template-columns: repeat(5, 1fr);
	border: 1px solid var(--border);
	border-radius: var(--radius-lg);
	background: var(--surface);
	overflow: hidden;
}

.stat {
	display: grid;
	gap: 6px;
	padding: var(--space-4) var(--space-5);
	border-right: 1px solid var(--border);
}

.stat:last-child {
	border-right: none;
}

.stat-value {
	font-family: var(--font-display);
	font-size: 2.1rem;
	line-height: 1;
	background: var(--white-gradient);
	-webkit-background-clip: text;
	background-clip: text;
	color: transparent;
}

@media (max-width: 960px) {
	.overview {
		grid-template-columns: 1fr;
	}
}

@media (max-width: 640px) {
	.facts {
		grid-template-columns: 1fr 1fr;
		gap: var(--space-4);
	}

	.stats {
		grid-template-columns: repeat(3, 1fr);
	}

	.stat {
		padding: var(--space-3) var(--space-4);
		border-bottom: 1px solid var(--border);
	}

	.stat:nth-child(3n) {
		border-right: none;
	}
}
</style>
