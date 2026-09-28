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
const showTrace = ref(false);
const loading = ref(true);
const error = ref("");
const tab = ref<"report" | "sources" | "trace">("report");

const statusLabel: Record<SourceAttempt["status"], string> = {
	fetched: "Fetched",
	skipped_seen: "Skipped (already seen)",
	rejected: "Rejected by guardrail",
	failed: "Failed",
};
const statusClass: Record<SourceAttempt["status"], string> = {
	fetched: "badge-new",
	skipped_seen: "badge-still",
	rejected: "badge-danger",
	failed: "badge-warn",
};

const totals = computed(() => run.value?.budgetTotals ?? null);

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
	return text && text.length > 160 ? `${text.slice(0, 160)}…` : (text ?? "");
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
	if (!showTrace.value) {
		showTrace.value = true;
		await loadTrace().catch((err) => (error.value = (err as Error).message));
	}
}
</script>

<template>
	<div class="page">
		<div class="page-header">
			<div>
				<RouterLink to="/runs" class="subtle">← Run history</RouterLink>
				<h1>Run {{ runId.slice(0, 8) }}</h1>
				<p v-if="run">{{ formatDateTime(run.startedAt) }}<span v-if="run.finishedAt"> · {{ formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) }}</span></p>
			</div>
			<div class="row">
				<RunStatusBadge v-if="run" :status="run.status" :stale="run.errorCode === 'abandoned'" />
				<button v-if="markdown" type="button" class="btn btn-secondary" @click="downloadMarkdown">Export Markdown</button>
			</div>
		</div>

		<p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>
		<p v-if="loading" class="muted">Loading run…</p>

		<template v-if="run && !loading">
			<p v-if="run.stopReason" :class="['alert', run.status === 'failed' ? 'alert-error' : 'alert-warn']">Stopped: {{ run.stopReason }}</p>

			<section class="card card-compact stats" aria-label="Run totals">
				<div><span class="stat">{{ run.attemptCounts.fetched ?? 0 }}</span><span class="subtle">fetched</span></div>
				<div><span class="stat">{{ run.attemptCounts.skipped_seen ?? 0 }}</span><span class="subtle">skipped (seen)</span></div>
				<div><span class="stat">{{ run.attemptCounts.rejected ?? 0 }}</span><span class="subtle">rejected</span></div>
				<div><span class="stat">{{ run.attemptCounts.failed ?? 0 }}</span><span class="subtle">failed</span></div>
				<div v-if="totals"><span class="stat">{{ totals.modelCalls ?? 0 }}</span><span class="subtle">model calls</span></div>
				<div v-if="totals"><span class="stat">{{ ((totals.inputTokens ?? 0) + (totals.outputTokens ?? 0)).toLocaleString() }}</span><span class="subtle">tokens</span></div>
				<div v-if="totals"><span class="stat">{{ totals.searchCredits ?? 0 }}</span><span class="subtle">search credits</span></div>
				<div v-if="totals"><span class="stat">{{ totals.networkRequests ?? 0 }}</span><span class="subtle">external requests</span></div>
			</section>

			<div class="tabs" role="tablist">
				<button type="button" role="tab" :aria-selected="tab === 'report'" :class="{ active: tab === 'report' }" @click="tab = 'report'">Report</button>
				<button type="button" role="tab" :aria-selected="tab === 'sources'" :class="{ active: tab === 'sources' }" @click="tab = 'sources'">Articles ({{ sources.length }})</button>
				<button type="button" role="tab" :aria-selected="tab === 'trace'" :class="{ active: tab === 'trace' }" @click="openTrace">Trace</button>
			</div>

			<div v-if="tab === 'report'">
				<ReportSections v-if="report" :report="report" />
				<p v-else class="card card-compact muted">This run has no report yet.</p>
			</div>

			<div v-else-if="tab === 'sources'" class="stack">
				<p class="subtle">Every page the agent tried to fetch on this run, including ones reused from earlier runs and ones the guardrails refused.</p>
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
								<td class="nowrap">{{ formatDateTime(source.fetchedAt ?? source.attemptedAt) }}</td>
								<td>
									<span :class="['badge', statusClass[source.status]]">{{ statusLabel[source.status] }}</span>
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
					<table>
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
								<td>{{ event.step }}</td>
								<td>{{ event.category }}</td>
								<td class="url-cell">{{ event.tool ?? event.service ?? "—" }}</td>
								<td>
									<span :class="['badge', event.status === 'ok' || /^2/.test(event.status) ? 'badge-new' : event.status === 'error' || event.status === 'rejected' ? 'badge-danger' : '']">{{ event.status }}</span>
									<span v-if="event.errorCode" class="subtle"> {{ event.errorCode }}</span>
								</td>
								<td class="nowrap">{{ event.latencyMs !== null ? `${event.latencyMs} ms` : "—" }}</td>
								<td class="nowrap">{{ event.inputTokens !== null ? `${event.inputTokens} in / ${event.outputTokens ?? 0} out` : "—" }}</td>
								<td class="url-cell">{{ short(event.arguments) }}</td>
							</tr>
						</tbody>
					</table>
				</div>
				<div v-if="traceCursor"><button type="button" class="btn btn-secondary" @click="loadTrace(traceCursor!)">Load more</button></div>
			</div>
		</template>
	</div>
</template>

<style scoped>
.stats {
	grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
	text-align: center;
}

.stats > div {
	display: grid;
}

.stat {
	font-size: 1.35rem;
	font-weight: 700;
	font-variant-numeric: tabular-nums;
}

.tabs {
	display: flex;
	gap: var(--space-1);
	border-bottom: 1px solid var(--border);
	overflow-x: auto;
}

.tabs button {
	font: inherit;
	font-weight: 560;
	background: none;
	border: none;
	border-bottom: 2px solid transparent;
	padding: 8px 14px;
	color: var(--text-muted);
	cursor: pointer;
	white-space: nowrap;
}

.tabs button.active {
	color: var(--accent-text);
	border-bottom-color: var(--accent);
}

.title-cell {
	max-width: 260px;
	overflow-wrap: anywhere;
}

.nowrap {
	white-space: nowrap;
}

.reason {
	margin-top: 4px;
	max-width: 280px;
}
</style>
