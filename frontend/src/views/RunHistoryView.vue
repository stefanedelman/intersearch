<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { ApiError } from "../api/client";
import { formatDateTime, formatDuration, trackerApi, type RunSummary } from "../api/tracker";
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
				<span class="command">npm run tracker:run</span>
			</div>
		</section>

		<div v-else-if="runs.length" class="table-wrap">
			<table>
				<thead>
					<tr>
						<th scope="col">Started</th>
						<th scope="col">Status</th>
						<th scope="col" class="num">New</th>
						<th scope="col" class="num">Still</th>
						<th scope="col" class="num">Dropped</th>
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
						<td><RunStatusBadge :status="run.status" :stale="run.errorCode === 'abandoned'" /></td>
						<td class="num mono">{{ run.hasReport ? run.counts.new : "—" }}</td>
						<td class="num mono">{{ run.hasReport ? run.counts.still + run.counts.returned : "—" }}</td>
						<td class="num mono">{{ run.hasReport ? run.counts.dropped : "—" }}</td>
						<td class="mono dim">{{ duration(run) }}</td>
						<td class="notes">{{ run.stopReason ?? (run.baselineRunId ? "Compared with the previous complete run" : "First run for this target") }}</td>
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

.notes {
	color: var(--text-muted);
	max-width: 340px;
	font-size: 13px;
}
</style>
