<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { ApiError } from "../api/client";
import { CLAIM_LABEL_TEXT, CLAIM_LABELS, formatDateTime, formatDuration, safeHref, trackerApi, WORKER_TEXT, type ClaimCounts, type ClaimLabel, type ClaimRow, type Report, type RunDetail, type SourceAttempt, type TraceEvent } from "../api/tracker";
import ClaimList from "../components/ClaimList.vue";
import LedgerBars from "../components/LedgerBars.vue";
import LiveRun from "../components/LiveRun.vue";
import ReportSections from "../components/ReportSections.vue";
import RunStatusBadge from "../components/RunStatusBadge.vue";
import WorkerCallsTable from "../components/WorkerCallsTable.vue";

const route = useRoute();
const runId = computed(() => String(route.params.id));

const run = ref<RunDetail | null>(null);
const report = ref<Report | null>(null);
const markdown = ref("");
const sources = ref<SourceAttempt[]>([]);
const trace = ref<TraceEvent[]>([]);
const traceCursor = ref<string | null>(null);
const traceLoaded = ref(false);
const loading = ref(true);
const error = ref("");
const tab = ref<"report" | "sources" | "trace" | "claims" | "network">("report");
const claims = ref<ClaimRow[]>([]);
const claimCounts = ref<ClaimCounts | null>(null);
const claimFilter = ref<ClaimLabel | null>(null);
const claimsLoaded = ref(false);
const orchestrated = computed(() => run.value?.kind === "orchestrated");

const statusLabel: Record<SourceAttempt["status"], string> = {
	fetched: "Fetched",
	skipped_seen: "Reused",
	rejected: "Blocked",
	failed: "Failed",
};
const statusClass: Record<SourceAttempt["status"], string> = {
	fetched: "badge-new",
	skipped_seen: "badge-still",
	rejected: "badge-danger",
	failed: "badge-warn",
};

const totals = computed(() => run.value?.budgetTotals ?? null);
const stats = computed(() => {
	if (!run.value) return [];
	if (orchestrated.value) {
		const counts = run.value.claimCounts ?? { supported: 0, unsupported: 0, unreachable: 0, unverified: 0 };
		const ledger = run.value.ledger;
		const list: { label: string; value: string | number }[] = CLAIM_LABELS.map((label) => ({ label: CLAIM_LABEL_TEXT[label], value: counts[label] }));
		list.push({ label: "Worker requests", value: run.value.workerCalls.filter((call) => call.endpoint !== "/healthz").length });
		if (ledger) list.push({ label: "Tokens charged", value: `${ledger.charged.tokens.toLocaleString()}` });
		return list;
	}
	const counts = run.value.attemptCounts;
	const list: { label: string; value: string | number }[] = [
		{ label: "Fetched", value: counts.fetched ?? 0 },
		{ label: "Reused", value: counts.skipped_seen ?? 0 },
		{ label: "Blocked", value: counts.rejected ?? 0 },
		{ label: "Failed", value: counts.failed ?? 0 },
	];
	if (totals.value) {
		list.push(
			{ label: "Model calls", value: totals.value.modelCalls ?? 0 },
			{ label: "Tokens", value: ((totals.value.inputTokens ?? 0) + (totals.value.outputTokens ?? 0)).toLocaleString() },
			{ label: "Searches", value: totals.value.searches ?? 0 },
			{ label: "Requests", value: totals.value.networkRequests ?? 0 },
		);
	}
	return list;
});

async function loadTrace(cursor?: string) {
	const page = await trackerApi.trace(runId.value, cursor);
	trace.value = cursor ? [...trace.value, ...page.events] : page.events;
	traceCursor.value = page.nextCursor;
}

function downloadMarkdown() {
	// Exported as a plain-text file; the browser never renders it as HTML.
	const blob = new Blob([markdown.value], { type: "text/markdown;charset=utf-8" });
	const link = document.createElement("a");
	link.href = URL.createObjectURL(blob);
	link.download = `intersearch-${runId.value.slice(0, 8)}.md`;
	link.click();
	URL.revokeObjectURL(link.href);
}

function short(value: unknown) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text && text.length > 140 ? `${text.slice(0, 140)}…` : (text ?? "");
}

function traceStatusClass(status: string) {
	if (status === "ok" || /^2/.test(status)) return "badge-new";
	if (status === "error" || status === "rejected" || status === "exhausted") return "badge-danger";
	if (status === "retry" || status === "invalid") return "badge-warn";
	return "";
}

async function load() {
	const detail = await trackerApi.run(runId.value);
	run.value = detail.run;
	if (detail.run.kind !== "orchestrated") sources.value = (await trackerApi.sources(runId.value)).sources;
	if (detail.run.hasReport) {
		const saved = await trackerApi.report(runId.value);
		report.value = saved.report;
		markdown.value = saved.markdown;
	}
}

async function loadClaims() {
	const result = await trackerApi.claims(runId.value, claimFilter.value ?? undefined);
	claims.value = result.claims;
	claimCounts.value = result.counts;
	claimsLoaded.value = true;
}

async function openClaims() {
	tab.value = "claims";
	if (!claimsLoaded.value) await loadClaims().catch((err) => (error.value = (err as Error).message));
}

async function filterClaims(label: ClaimLabel | null) {
	claimFilter.value = label;
	await loadClaims().catch((err) => (error.value = (err as Error).message));
}

async function onFinished() {
	claimsLoaded.value = false;
	await load().catch((err) => (error.value = (err as Error).message));
}

onMounted(async () => {
	try {
		await load();
	} catch (err) {
		error.value = err instanceof ApiError && err.status === 404 ? "Run not found." : (err as Error).message;
	} finally {
		loading.value = false;
	}
});

async function openTrace() {
	tab.value = "trace";
	if (!traceLoaded.value) {
		traceLoaded.value = true;
		await loadTrace().catch((err) => (error.value = (err as Error).message));
	}
}
</script>

<template>
	<div class="page">
		<header class="page-header">
			<div>
				<RouterLink to="/runs" class="eyebrow back">← Run history</RouterLink>
				<h1 class="display">Run <span class="mono run-id">{{ runId.slice(0, 8) }}</span></h1>
				<p v-if="run" class="lead">
					{{ formatDateTime(run.startedAt) }}<span v-if="run.finishedAt"> · took {{ formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) }}</span>
				</p>
			</div>
			<div class="row">
				<span v-if="run" class="mono kind">{{ run.kind === "orchestrated" ? "Orchestrated" : "1B tracker" }}</span>
				<RunStatusBadge v-if="run" :status="run.status" :stale="run.errorCode === 'abandoned' || run.errorCode === 'orchestrator_restarted'" />
				<button v-if="markdown" type="button" class="btn btn-secondary btn-sm" @click="downloadMarkdown">Export Markdown</button>
			</div>
		</header>

		<p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>
		<div v-if="loading" class="skeleton" style="height: 200px" aria-label="Loading run"></div>

		<template v-if="run && !loading">
			<LiveRun v-if="run.status === 'running' && orchestrated" :run-id="run.id" @finished="onFinished" />
			<p v-if="run.stopReason" :class="['alert', run.status === 'failed' ? 'alert-error' : 'alert-warn']">
				Stopped: {{ run.stopReason }}<span v-if="run.failedWorkers.length"> · failed worker: {{ run.failedWorkers.map((worker) => WORKER_TEXT[worker]).join(", ") }}</span>
			</p>

			<section class="stats" aria-label="Run totals">
				<div v-for="stat in stats" :key="stat.label" class="stat">
					<span class="stat-value">{{ stat.value }}</span>
					<span class="eyebrow">{{ stat.label }}</span>
				</div>
			</section>

			<div class="tabs" role="tablist" aria-label="Run details">
				<button type="button" role="tab" :aria-selected="tab === 'report'" :class="{ active: tab === 'report' }" @click="tab = 'report'">Report</button>
				<template v-if="orchestrated">
					<button type="button" role="tab" :aria-selected="tab === 'claims'" :class="{ active: tab === 'claims' }" @click="openClaims">
						Claims <span class="tab-count mono">{{ run.claimCounts ? Object.values(run.claimCounts).reduce((a, b) => a + b, 0) : 0 }}</span>
					</button>
					<button type="button" role="tab" :aria-selected="tab === 'network'" :class="{ active: tab === 'network' }" @click="tab = 'network'">
						Network <span class="tab-count mono">{{ run.workerCalls.length }}</span>
					</button>
				</template>
				<template v-else>
					<button type="button" role="tab" :aria-selected="tab === 'sources'" :class="{ active: tab === 'sources' }" @click="tab = 'sources'">
						Articles <span class="tab-count mono">{{ sources.length }}</span>
					</button>
					<button type="button" role="tab" :aria-selected="tab === 'trace'" :class="{ active: tab === 'trace' }" @click="openTrace">Trace</button>
				</template>
			</div>

			<div v-if="tab === 'report'">
				<ReportSections v-if="report" :report="report" />
				<p v-else class="card card-compact muted">This run has no report yet.</p>
			</div>

			<div v-else-if="tab === 'claims'" class="stack">
				<p class="subtle">Every claim the researcher made, with the verifier's label. Supported claims carry an excerpt that code confirmed is on the cited page.</p>
				<div class="filters" role="group" aria-label="Filter claims by label">
					<button type="button" :class="['btn', 'btn-sm', claimFilter === null ? 'btn-secondary' : 'btn-ghost']" @click="filterClaims(null)">All</button>
					<button v-for="label in CLAIM_LABELS" :key="label" type="button" :class="['btn', 'btn-sm', claimFilter === label ? 'btn-secondary' : 'btn-ghost']" @click="filterClaims(label)">
						{{ CLAIM_LABEL_TEXT[label] }} <span class="mono tab-count">{{ claimCounts?.[label] ?? 0 }}</span>
					</button>
				</div>
				<div class="card card-compact">
					<ClaimList v-if="claims.length" :claims="claims" />
					<p v-else-if="claimsLoaded" class="muted">No claims{{ claimFilter ? ` labelled ${CLAIM_LABEL_TEXT[claimFilter].toLowerCase()}` : "" }}.</p>
				</div>
			</div>

			<div v-else-if="tab === 'network'" class="stack">
				<p class="subtle">Every request the orchestrator sent to a worker, with each attempt (→ marks a retry). Latency is measured by the orchestrator, not the worker. Charged is steps / fetches / tokens.</p>
				<div v-if="run.ledger" class="card card-compact ledger-card">
					<span class="eyebrow">Run budget (charged once per request)</span>
					<LedgerBars :ledger="run.ledger" />
				</div>
				<WorkerCallsTable :calls="run.workerCalls" />
			</div>

			<div v-else-if="tab === 'sources'" class="stack">
				<p class="subtle">Every page the agent tried to fetch on this run, including ones reused from earlier runs and ones the guardrails blocked.</p>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col">Title</th>
								<th scope="col">URL</th>
								<th scope="col">Fetched</th>
								<th scope="col">Status</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="source in sources" :key="source.id">
								<td class="title-cell">{{ source.title ?? "—" }}</td>
								<td class="url-cell">
									<a v-if="source.status !== 'rejected' && safeHref(source.finalUrl ?? source.requestedUrl)" :href="safeHref(source.finalUrl ?? source.requestedUrl)!" target="_blank" rel="noopener noreferrer">{{ source.requestedUrl }}</a>
									<span v-else>{{ source.requestedUrl }}</span>
								</td>
								<td class="mono dim">{{ formatDateTime(source.fetchedAt ?? source.attemptedAt) }}</td>
								<td>
									<span :class="['badge', 'badge-dot', statusClass[source.status]]">{{ statusLabel[source.status] }}</span>
									<p v-if="source.reason" class="subtle reason">{{ source.reason }}</p>
								</td>
							</tr>
							<tr v-if="!sources.length">
								<td colspan="4" class="muted">No articles were fetched on this run.</td>
							</tr>
						</tbody>
					</table>
				</div>
			</div>

			<div v-else class="stack">
				<p class="subtle">Every model call, tool call, and network round trip, with arguments redacted.</p>
				<div class="table-wrap">
					<table class="trace">
						<thead>
							<tr>
								<th scope="col">Step</th>
								<th scope="col">Kind</th>
								<th scope="col">Tool / service</th>
								<th scope="col">Status</th>
								<th scope="col">Latency</th>
								<th scope="col">Tokens</th>
								<th scope="col">Arguments</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="event in trace" :key="event.id">
								<td class="mono dim">{{ event.step }}</td>
								<td class="mono">{{ event.category }}</td>
								<td class="url-cell">{{ event.tool ?? event.service ?? "—" }}</td>
								<td>
									<span :class="['badge', traceStatusClass(event.status)]">{{ event.status }}</span>
									<span v-if="event.errorCode" class="subtle"> {{ event.errorCode }}</span>
								</td>
								<td class="mono dim">{{ event.latencyMs !== null ? `${event.latencyMs} ms` : "—" }}</td>
								<td class="mono dim">{{ event.inputTokens !== null ? `${event.inputTokens} / ${event.outputTokens ?? 0}` : "—" }}</td>
								<td class="url-cell">{{ short(event.arguments) }}</td>
							</tr>
							<tr v-if="traceLoaded && !trace.length">
								<td colspan="7" class="muted">No trace events.</td>
							</tr>
						</tbody>
					</table>
				</div>
				<div v-if="traceCursor"><button type="button" class="btn btn-secondary btn-sm" @click="loadTrace(traceCursor!)">Load more</button></div>
			</div>
		</template>
	</div>
</template>

<style scoped>
.back {
	display: inline-block;
	margin-bottom: var(--space-3);
	text-decoration: none;
}

.back:hover {
	color: var(--text);
}

.run-id {
	font-size: 0.55em;
	-webkit-text-fill-color: var(--text-muted);
	letter-spacing: 0;
	vertical-align: 0.2em;
}

.stats {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
	border: 1px solid var(--border);
	border-radius: var(--radius-lg);
	background: var(--surface);
	overflow: hidden;
}

.stat {
	display: grid;
	gap: 6px;
	padding: var(--space-4) var(--space-5);
	box-shadow: 1px 0 0 var(--border), 0 1px 0 var(--border);
}

.stat-value {
	font-family: var(--font-display);
	font-size: 1.9rem;
	line-height: 1;
	background: var(--white-gradient);
	-webkit-background-clip: text;
	background-clip: text;
	color: transparent;
}

.tabs {
	display: inline-flex;
	justify-self: start;
	gap: 2px;
	padding: 3px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	background: var(--surface);
	max-width: 100%;
	overflow-x: auto;
}

.tabs button {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	height: 30px;
	padding: 0 14px;
	font: inherit;
	font-size: 13px;
	font-weight: 500;
	background: none;
	border: none;
	border-radius: var(--radius-sm);
	color: var(--text-muted);
	cursor: pointer;
	white-space: nowrap;
	transition: background 0.15s, color 0.15s;
}

.tabs button:hover {
	color: var(--text);
}

.tabs button.active {
	color: var(--text);
	background: var(--surface-strong);
	box-shadow: inset 0 0 0 1px var(--border);
}

.tab-count {
	font-size: 11px;
	color: var(--text-subtle);
}

.title-cell {
	max-width: 260px;
	overflow-wrap: anywhere;
	font-weight: 500;
}

.dim {
	color: var(--text-muted);
	font-size: 12px;
	white-space: nowrap;
}

.reason {
	margin-top: 6px;
	max-width: 280px;
	font-size: 12px;
}

.kind {
	font-size: 11px;
	color: var(--text-muted);
}

.filters {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}

.ledger-card {
	gap: var(--space-3);
	max-width: 560px;
}

.trace td {
	font-size: 12.5px;
}
</style>
