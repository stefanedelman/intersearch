<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ApiError } from "../api/client";
import { formatDateTime, formatDuration, trackerApi, WORKER_TEXT, type RunSummary } from "../api/tracker";
import RunStatusBadge from "../components/RunStatusBadge.vue";

const router = useRouter();
const runs = ref<RunSummary[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref("");

async function load(cursor?: string) {
	const page = await trackerApi.runs(cursor);
	runs.value = cursor ? [...runs.value, ...page.runs] : page.runs;
	nextCursor.value = page.nextCursor;
}

async function more() {
	if (!nextCursor.value) return;
	loadingMore.value = true;
	try {
		await load(nextCursor.value);
	} catch (err) {
		error.value = (err as Error).message;
	} finally {
		loadingMore.value = false;
	}
}

function duration(run: RunSummary) {
	return run.finishedAt ? formatDuration(new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) : "—";
}

function notes(run: RunSummary) {
	if (run.stopReason) return run.stopReason;
	if (run.status === "running") return run.phase ? `In progress: ${run.phase}` : "In progress";
	return run.baselineRunId ? "Compared with the previous run" : "First run for this target";
}

function open(run: RunSummary) {
	void router.push(`/runs/${run.id}`);
}

onMounted(async () => {
	try {
		await load();
	} catch (err) {
		error.value = err instanceof ApiError ? err.message : "Could not load run history.";
	} finally {
		loading.value = false;
	}
});
</script>

<template>
	<div class="page">
		<header class="page-header">
			<div>
				<p class="eyebrow">Tracker</p>
				<h1 class="display">Run history</h1>
				<p class="lead">Every run, newest first, with what changed since the one before.</p>
			</div>
		</header>

		<p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>
		<div v-if="loading" class="skeleton" style="height: 240px" aria-label="Loading runs"></div>

		<section v-else-if="!runs.length && !error" class="card">
			<div class="empty">
				<span class="eyebrow">No runs yet</span>
				<h2>Nothing to show</h2>
				<p class="muted">Start one with <strong>Run tracker</strong> on the dashboard.</p>
				<RouterLink to="/" class="btn btn-secondary">Go to the dashboard</RouterLink>
			</div>
		</section>

		<div v-else-if="runs.length" class="table-wrap">
			<table>
				<thead>
					<tr>
						<th scope="col">Started</th>
						<th scope="col">Kind</th>
						<th scope="col">Status</th>
						<th scope="col">Failed worker</th>
						<th scope="col" class="num">New</th>
						<th scope="col" class="num">Still</th>
						<th scope="col" class="num">Dropped</th>
						<th scope="col" title="Supported / unsupported / unreachable / unverified claims">Claims</th>
						<th scope="col">Duration</th>
						<th scope="col">Notes</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="run in runs" :key="run.id" class="clickable" @click="open(run)">
						<td>
							<RouterLink :to="`/runs/${run.id}`" class="run-link" @click.stop>{{ formatDateTime(run.startedAt) }}</RouterLink>
							<span class="mono run-id">{{ run.id.slice(0, 8) }}</span>
						</td>
						<td class="kind mono">{{ run.kind === "orchestrated" ? "Orchestrated" : "1B tracker" }}</td>
						<td>
							<RunStatusBadge :status="run.status" :stale="run.errorCode === 'abandoned' || run.errorCode === 'orchestrator_restarted'" />
							<span v-if="run.stale" class="badge badge-warn stale">Stale</span>
						</td>
						<td class="failed">{{ run.failedWorkers.length ? run.failedWorkers.map((worker) => WORKER_TEXT[worker]).join(", ") : "—" }}</td>
						<td class="num mono">{{ run.hasReport ? run.counts.new : "—" }}</td>
						<td class="num mono">{{ run.hasReport ? run.counts.still + run.counts.returned : "—" }}</td>
						<td class="num mono">{{ run.hasReport ? run.counts.dropped : "—" }}</td>
						<td class="mono claims">
							<template v-if="run.claimCounts">
								<span class="c-ok" title="Supported">✔ {{ run.claimCounts.supported }}</span>
								<span class="c-bad" title="Unsupported">✖ {{ run.claimCounts.unsupported }}</span>
								<span class="c-dim" title="Unreachable">⊘ {{ run.claimCounts.unreachable }}</span>
								<span class="c-warn" title="Unverified">? {{ run.claimCounts.unverified }}</span>
							</template>
							<span v-else class="c-dim">—</span>
						</td>
						<td class="mono dim">{{ duration(run) }}</td>
						<td class="notes">{{ notes(run) }}</td>
					</tr>
				</tbody>
			</table>
		</div>

		<div v-if="nextCursor">
			<button type="button" class="btn btn-secondary" :disabled="loadingMore" @click="more">{{ loadingMore ? "Loading…" : "Load older runs" }}</button>
		</div>
	</div>
</template>

<style scoped>
.clickable {
	cursor: pointer;
}

.run-link {
	display: block;
	font-weight: 500;
	text-decoration: none;
	white-space: nowrap;
}

.run-id {
	font-size: 11px;
	color: var(--text-subtle);
}

.num {
	text-align: right;
}

.dim {
	color: var(--text-muted);
	white-space: nowrap;
}

.kind {
	font-size: 11px;
	color: var(--text-muted);
	white-space: nowrap;
}

.stale {
	margin-left: 4px;
}

.failed {
	color: var(--red);
	white-space: nowrap;
}

.claims {
	white-space: nowrap;
	font-size: 12px;
}

.claims span + span {
	margin-left: 8px;
}

.c-ok {
	color: var(--green);
}

.c-bad {
	color: var(--red);
}

.c-dim {
	color: var(--text-subtle);
}

.c-warn {
	color: var(--orange);
}

.notes {
	color: var(--text-muted);
	max-width: 340px;
	font-size: 13px;
}
</style>
