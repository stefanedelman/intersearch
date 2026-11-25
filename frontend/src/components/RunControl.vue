<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ApiError } from "../api/client";
import { formatDateTime, formatDuration, trackerApi, type RunSummary, type TrackerConfigView, type WorkerHealth, type WorkerName } from "../api/tracker";
import RunStatusBadge from "./RunStatusBadge.vue";

// The dashboard's Run card: worker health (probed by our API, never by the browser directly),
// a Wake button for the verifier on Render's free tier, and the Run button.
const props = defineProps<{ running: boolean; latest: RunSummary | null; config: TrackerConfigView | null }>();
const emit = defineEmits<{ started: [runId: string] }>();

const health = ref<Record<WorkerName, WorkerHealth> | null>(null);
const checking = ref(false);
const waking = ref(false);
const wokeIn = ref<number | null>(null);
const starting = ref(false);
const error = ref("");
let timer: ReturnType<typeof setInterval> | undefined;

async function check() {
	checking.value = true;
	try {
		const result = await trackerApi.workers();
		health.value = { researcher: result.researcher, verifier: result.verifier };
	} catch (err) {
		error.value = err instanceof ApiError ? err.message : "Could not check the workers.";
	} finally {
		checking.value = false;
	}
}

async function wake() {
	waking.value = true;
	wokeIn.value = null;
	error.value = "";
	try {
		const result = await trackerApi.wakeVerifier();
		if (health.value) health.value = { ...health.value, verifier: result.verifier };
		if (result.verifier.state === "up") wokeIn.value = result.verifier.latencyMs;
		else error.value = `The verifier did not wake within ${Math.round(result.timeoutMs / 1000)} s (${result.verifier.detail ?? result.verifier.state}).`;
	} catch (err) {
		error.value = err instanceof ApiError ? err.message : "Could not wake the verifier.";
	} finally {
		waking.value = false;
	}
}

async function start() {
	starting.value = true;
	error.value = "";
	try {
		// One key per click: a retried request returns the same run instead of starting a second one.
		const result = await trackerApi.startRun(crypto.randomUUID());
		emit("started", result.runId);
	} catch (err) {
		error.value = err instanceof ApiError ? err.message : "Could not start the run.";
	} finally {
		starting.value = false;
	}
}

const notConfigured = computed(() => health.value && (health.value.researcher.state === "not_configured" || health.value.verifier.state === "not_configured"));
const researcherDown = computed(() => health.value?.researcher.state === "down" || health.value?.researcher.state === "asleep");
const budget = computed(() => props.config?.orchestration?.totalBudget ?? null);

function chip(service: WorkerName) {
	const entry = health.value?.[service];
	if (service === "verifier" && waking.value) return { text: "waking…", cls: "warn" };
	if (!entry) return { text: checking.value ? "checking…" : "unknown", cls: "" };
	const ms = entry.latencyMs !== null && entry.state === "up" ? ` ${entry.latencyMs} ms` : "";
	return {
		up: { text: `up${ms}`, cls: "ok" },
		asleep: { text: "asleep", cls: "warn" },
		down: { text: "down", cls: "bad" },
		not_configured: { text: "not configured", cls: "bad" },
	}[entry.state];
}

onMounted(() => {
	void check();
	timer = setInterval(() => {
		if (!document.hidden && !waking.value) void check();
	}, 30_000);
});
onBeforeUnmount(() => clearInterval(timer));
defineExpose({ check });
</script>

<template>
	<div class="card overview-run">
		<div class="row between">
			<span class="eyebrow">02 / Run the tracker</span>
			<RunStatusBadge v-if="running" status="running" />
			<RunStatusBadge v-else-if="latest" :status="latest.status" :stale="latest.errorCode === 'abandoned' || latest.errorCode === 'orchestrator_restarted'" />
		</div>

		<ul class="workers" aria-label="Worker status">
			<li v-for="service in ['researcher', 'verifier'] as const" :key="service" :title="health?.[service].detail ?? health?.[service].url ?? ''">
				<span :class="['dot', chip(service).cls]" aria-hidden="true"></span>
				<span class="name">{{ service === "researcher" ? "Researcher" : "Verifier" }}</span>
				<span class="mono state">{{ chip(service).text }}</span>
			</li>
		</ul>
		<p v-if="wokeIn !== null" class="subtle">Verifier woke in {{ formatDuration(wokeIn) }}.</p>

		<div class="actions">
			<button type="button" class="btn btn-primary" :disabled="running || starting || Boolean(notConfigured)" @click="start">
				{{ running ? "Run in progress" : starting ? "Starting…" : "Run tracker" }}
			</button>
			<button type="button" class="btn btn-secondary btn-sm" :disabled="waking || health?.verifier.state === 'not_configured'" @click="wake">{{ waking ? "Waking…" : "Wake verifier" }}</button>
			<button type="button" class="btn btn-ghost btn-sm" :disabled="checking" @click="check">Recheck</button>
		</div>

		<p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>
		<p v-else-if="notConfigured" class="alert alert-warn">Set RESEARCHER_TOKEN and VERIFIER_TOKEN in backend/.env.local, then restart the API.</p>
		<p v-else-if="researcherDown && !running" class="alert alert-warn">The researcher is not answering. A run now will show the previous results, marked stale.</p>

		<p v-if="budget" class="subtle mono budget">Budget per run: {{ budget.max_steps }} steps · {{ budget.max_fetches }} fetches · {{ budget.max_tokens.toLocaleString() }} tokens</p>
		<p v-if="latest && !running" class="subtle">
			Last run {{ formatDateTime(latest.startedAt) }} ·
			<RouterLink :to="`/runs/${latest.id}`">details →</RouterLink>
		</p>
		<p class="subtle cli">Or from a terminal: <span class="mono">npm run tracker:run</span></p>
	</div>
</template>

<style scoped>
.overview-run {
	border-top: 2px solid var(--pink);
	align-content: start;
	gap: var(--space-4);
}

.between {
	justify-content: space-between;
}

.workers {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 6px;
}

.workers li {
	display: grid;
	grid-template-columns: 10px 90px 1fr;
	align-items: center;
	gap: 8px;
	font-size: 14px;
}

.dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: var(--text-faint);
}

.dot.ok {
	background: var(--green);
	box-shadow: 0 0 8px var(--green);
}

.dot.warn {
	background: var(--orange);
	animation: pulse 1.2s ease-in-out infinite;
}

.dot.bad {
	background: var(--red);
}

.name {
	font-weight: 500;
}

.state {
	font-size: 12px;
	color: var(--text-muted);
}

.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	align-items: center;
}

.budget {
	font-size: 11px;
}

.cli {
	font-size: 12px;
}

@keyframes pulse {
	50% {
		opacity: 0.3;
	}
}
</style>
