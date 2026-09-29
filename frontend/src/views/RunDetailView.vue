<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { ApiError } from "../api/client";
import { formatDateTime, formatDuration, safeHref, trackerApi, type Report, type RunSummary, type SourceAttempt, type TraceEvent } from "../api/tracker";
import ReportSections from "../components/ReportSections.vue";
import RunStatusBadge from "../components/RunStatusBadge.vue";

const route = useRoute();
const runId = computed(() => String(route.params.id));

const run = ref<(RunSummary & { attemptCounts: Record<string, number> }) | null>(null);
const report = ref<Report | null>(null);
const markdown = ref("");
const sources = ref<SourceAttempt[]>([]);
const trace = ref<TraceEvent[]>([]);
const traceCursor = ref<string | null>(null);
const traceLoaded = ref(false);
const loading = ref(true);
const error = ref("");
const tab = ref<"report" | "sources" | "trace">("report");

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

onMounted(async () => {
	try {
		const [detail, sourcePage] = await Promise.all([trackerApi.run(runId.value), trackerApi.sources(runId.value)]);
		run.value = detail.run;
		sources.value = sourcePage.sources;
		if (detail.run.hasReport) {
			const saved = await trackerApi.report(runId.value);
			report.value = saved.report;
			markdown.value = saved.markdown;
		}
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
				<RunStatusBadge v-if="run" :status="run.status" :stale="run.errorCode === 'abandoned'" />
				<button v-if="markdown" type="button" class="btn btn-secondary btn-sm" @click="downloadMarkdown">Export Markdown</button>
			</div>
		</header>

		<p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>
		<div v-if="loading" class="skeleton" style="height: 200px" aria-label="Loading run"></div>

		<template v-if="run && !loading">
			<p v-if="run.stopReason" :class="['alert', run.status === 'failed' ? 'alert-error' : 'alert-warn']">Stopped: {{ run.stopReason }}</p>

			<section class="stats" aria-label="Run totals">
				<div v-for="stat in stats" :key="stat.label" class="stat">
					<span class="stat-value">{{ stat.value }}</span>
					<span class="eyebrow">{{ stat.label }}</span>
				</div>
			</section>

			<div class="tabs" role="tablist" aria-label="Run details">
				<button type="button" role="tab" :aria-selected="tab === 'report'" :class="{ active: tab === 'report' }" @click="tab = 'report'">Report</button>
				<button type="button" role="tab" :aria-selected="tab === 'sources'" :class="{ active: tab === 'sources' }" @click="tab = 'sources'">
					Articles <span class="tab-count mono">{{ sources.length }}</span>
				</button>
				<button type="button" role="tab" :aria-selected="tab === 'trace'" :class="{ active: tab === 'trace' }" @click="openTrace">Trace</button>
			</div>

			<div v-if="tab === 'report'">
				<ReportSections v-if="report" :report="report" />
				<p v-else class="card card-compact muted">This run has no report yet.</p>
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

.trace td {
	font-size: 12.5px;
}
</style>
