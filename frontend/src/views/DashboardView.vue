<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ApiError } from "../api/client";
import { trackerApi, type Report, type RunSummary, type TrackerOverview } from "../api/tracker";
import LiveRun from "../components/LiveRun.vue";
import ReportSections from "../components/ReportSections.vue";
import RunControl from "../components/RunControl.vue";
import { useAuth } from "../composables/useAuth";

const { user, refresh } = useAuth();

const overview = ref<TrackerOverview | null>(null);
const report = ref<Report | null>(null);
const reportRun = ref<RunSummary | null>(null);
const loading = ref(true);
const error = ref("");
/** The run being followed live: the one in progress, or the one just started from this page. */
const liveRunId = ref<string | null>(null);
const control = ref<InstanceType<typeof RunControl> | null>(null);

const config = computed(() => overview.value?.tracker.config ?? null);
const latest = computed(() => overview.value?.latestRun ?? null);
const running = computed(() => Boolean(liveRunId.value));

const stats = computed(() => {
	const current = report.value;
	if (!current) return [];
	const ranked = { label: "Ranked", value: current.items.filter((item) => !("stale" in item) || !item.stale).length };
	const fresh = { label: "New", value: current.items.filter((item) => item.section === "new" && (!("stale" in item) || !item.stale)).length };
	if (current.schemaVersion === 1) {
		const s = current.stats;
		return [ranked, fresh, { label: "Pages fetched", value: s.fetched }, { label: "Reused", value: s.skipped }, { label: "Blocked", value: s.rejected }];
	}
	const claims = current.stats.claims;
	const first = current.stale ? { label: "Shown (stale)", value: current.items.length } : ranked;
	return [first, fresh, { label: "Supported", value: claims.supported }, { label: "Not supported", value: claims.unsupported + claims.unreachable }, { label: "Unverified", value: claims.unverified }];
});

async function load() {
	const [nextOverview, latestReport] = await Promise.all([trackerApi.overview(), trackerApi.latestReport()]);
	overview.value = nextOverview;
	report.value = latestReport.report;
	reportRun.value = latestReport.run;
	if (nextOverview.runInProgress) liveRunId.value = nextOverview.runInProgress.id;
}

function onStarted(runId: string) {
	liveRunId.value = runId;
	void load().catch(() => undefined);
}

async function onFinished() {
	liveRunId.value = null;
	await load().catch((err) => (error.value = err instanceof ApiError ? err.message : "Could not load the report."));
	void control.value?.check();
}

onMounted(async () => {
	void refresh().catch(() => undefined);
	try {
		await load();
	} catch (err) {
		error.value = err instanceof ApiError ? err.message : "Could not load the tracker.";
	} finally {
		loading.value = false;
	}
});
</script>

<template>
	<div class="page">
		<header class="page-header dashboard-header">
			<div>
				<p class="eyebrow"><span class="dashboard-label">Dashboard</span> / {{ user?.username }}</p>
				<h1 class="headline">Find your<em>next move.</em></h1>
				<p class="lead">{{ config?.tracker.topic ?? "A little research. A clearer next step." }}</p>
			</div>
			<div class="header-aside"><span class="desk-sticker"><span aria-hidden="true">✳</span> Follow the<br />possibility.</span><RouterLink v-if="latest" to="/runs" class="btn btn-secondary">Run history ↗</RouterLink></div>
		</header>

		<p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>

		<div v-if="loading" class="stack" aria-live="polite" aria-label="Loading your tracker">
			<div class="skeleton" style="height: 150px"></div>
			<div class="skeleton" style="height: 260px"></div>
		</div>

		<template v-else-if="!error">
			<section class="overview" aria-label="Tracker overview">
				<div class="card overview-target">
					<div class="row between"><span class="eyebrow">01 / The search brief</span><span class="brief-cross" aria-hidden="true">↗</span></div>
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

				<RunControl ref="control" :running="running" :latest="latest" :config="config" @started="onStarted" />
			</section>

			<LiveRun v-if="liveRunId" :run-id="liveRunId" @finished="onFinished" />

			<template v-if="report && reportRun">
				<div class="stats" aria-label="Latest report at a glance">
					<div v-for="stat in stats" :key="stat.label" class="stat">
						<span class="stat-value">{{ stat.value }}</span>
						<span class="eyebrow">{{ stat.label }}</span>
					</div>
				</div>
				<ReportSections :report="report" />
			</template>

			<section v-else-if="!liveRunId" class="card first-run">
				<div class="first-run-top"><span class="eyebrow">Your shortlist starts here</span><span class="stamp">Awaiting first report</span></div>
				<div class="empty">
					<span class="empty-symbol" aria-hidden="true">↗</span>
					<h2>Good things are worth finding.</h2>
					<p>Press <strong>Run tracker</strong> above.<br />Your ranked shortlist, every claim checked against its source, will land right here.</p>
				</div>
				<div class="research-steps"><span><b>01</b> Read the job boards</span><span><b>02</b> Check every claim</span><span><b>03</b> See what changed</span></div>
			</section>
		</template>
	</div>
</template>

<style scoped>
.dashboard-header {
	align-items: center;
	padding-bottom: 32px;
}
.dashboard-header > div:first-child {
	flex: 1;
	min-width: 0;
}
.dashboard-label {
	color: var(--accent);
}
.header-aside {
	display: grid;
	justify-items: end;
	gap: 30px;
	padding-right: 8px;
}
.desk-sticker {
	display: block;
	position: relative;
	padding: 14px 18px;
	border: 2px solid var(--ink);
	background: var(--accent);
	color: var(--ink);
	font-family: var(--font-display);
	font-size: 26px;
	line-height: 1;
	transform: rotate(6deg);
	box-shadow: 4px 4px 0 #090a09, 5px 5px 0 var(--accent);
}
.desk-sticker > span {
	position: absolute;
	top: -22px;
	right: -12px;
	color: var(--pink);
	font-family: var(--font-sans);
	font-size: 42px;
	text-shadow: 2px 2px var(--ink);
}
.brief-cross {
	color: var(--accent);
	font-size: 22px;
	line-height: 1;
}
.overview-target {
	border-top: 2px solid var(--accent);
}
.first-run {
	background: linear-gradient(140deg, rgba(245, 220, 82, 0.035), transparent 60%), var(--surface);
}
.first-run-top {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	align-items: center;
	gap: 12px;
}
.first-run .empty {
	padding: 10px 8px 26px;
}
.empty-symbol {
	color: var(--accent);
	font-size: 48px;
	line-height: 1;
}
.first-run .empty h2 {
	font-size: clamp(2rem, 3vw, 2.8rem);
}
.first-run .empty p {
	max-width: 44ch;
}
.first-run .command {
	margin-top: 10px;
}
.research-steps {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 16px;
	border-top: 1px solid var(--border);
	padding-top: 20px;
	font-family: var(--font-mono);
	font-size: 10px;
	color: var(--text-muted);
}
.research-steps b {
	color: var(--accent);
	margin-right: 8px;
	font-weight: 400;
}

.page-header .eyebrow {
	margin-bottom: var(--space-3);
}

.overview {
	display: grid;
	grid-template-columns: 1.5fr 1fr;
	gap: var(--space-4);
}

.overview-target {
	align-content: start;
	gap: var(--space-4);
}

.facts {
	display: grid;
	grid-template-columns: auto auto minmax(0, 1fr);
	justify-content: start;
	gap: var(--space-5);
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
	overflow-wrap: anywhere;
}

.chips {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}

.chip {
	display: inline-flex;
	align-items: center;
	min-height: 26px;
	padding: 0 11px;
	border-radius: var(--radius-pill);
	border: 1px solid var(--border);
	background: rgba(255, 255, 255, 0.02);
	font-family: var(--font-mono);
	font-size: 11px;
	color: var(--text-muted);
}

.between {
	justify-content: space-between;
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
	font-family: var(--font-sans);
	font-weight: 700;
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
	.header-aside {
		padding: 0;
		justify-items: start;
	}
	.desk-sticker {
		display: none;
	}
	.research-steps {
		grid-template-columns: 1fr;
		gap: 10px;
	}
	.first-run-top .stamp {
		font-size: 8px;
	}
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
