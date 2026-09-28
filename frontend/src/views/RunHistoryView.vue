<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ApiError } from "../api/client";
import { formatDateTime, formatDuration, trackerApi, type RunSummary } from "../api/tracker";
import RunStatusBadge from "../components/RunStatusBadge.vue";

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
		<div class="page-header">
			<div>
				<h1>Run history</h1>
				<p>Every tracker run, newest first, with what changed.</p>
			</div>
		</div>

		<p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>
		<p v-if="loading" class="muted">Loading runs…</p>

		<section v-else-if="!runs.length && !error" class="card">
			<div class="empty">
				<h2>No runs yet</h2>
				<span class="command">npm run tracker:run</span>
			</div>
		</section>

		<div v-else-if="runs.length" class="table-wrap">
			<table>
				<thead>
					<tr>
						<th scope="col">Started</th>
						<th scope="col">Status</th>
						<th scope="col">New</th>
						<th scope="col">Still</th>
						<th scope="col">Dropped</th>
						<th scope="col">Duration</th>
						<th scope="col">Notes</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="run in runs" :key="run.id">
						<td>
							<RouterLink :to="`/runs/${run.id}`">{{ formatDateTime(run.startedAt) }}</RouterLink>
						</td>
						<td><RunStatusBadge :status="run.status" :stale="run.errorCode === 'abandoned'" /></td>
						<td>{{ run.hasReport ? run.counts.new : "—" }}</td>
						<td>{{ run.hasReport ? run.counts.still + run.counts.returned : "—" }}</td>
						<td>{{ run.hasReport ? run.counts.dropped : "—" }}</td>
						<td>{{ duration(run) }}</td>
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
.notes {
	color: var(--text-muted);
	max-width: 360px;
	font-size: 0.85rem;
}
</style>
