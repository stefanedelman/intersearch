<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ApiError } from "../api/client";
import { formatDuration, PHASES, trackerApi, type RunDetail } from "../api/tracker";
import { usePolling } from "../composables/usePolling";
import LedgerBars from "./LedgerBars.vue";
import WorkerCallsTable from "./WorkerCallsTable.vue";

// Live progress of a running orchestrated run, polled every 2 s: phase, elapsed time, every
// worker request with its attempts, and the budget charged so far.
const props = defineProps<{ runId: string }>();
const emit = defineEmits<{ finished: [run: RunDetail] }>();

const run = ref<RunDetail | null>(null);
const error = ref("");
const cancelling = ref(false);
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;

async function tick() {
	const detail = (await trackerApi.run(props.runId)).run;
	run.value = detail;
	if (detail.status !== "running") emit("finished", detail);
}

const polling = usePolling(tick, () => run.value === null || run.value.status === "running", 2000);

async function cancel() {
	cancelling.value = true;
	try {
		await trackerApi.cancelRun(props.runId);
		await tick();
	} catch (err) {
		error.value = err instanceof ApiError ? err.message : "Could not cancel the run.";
		cancelling.value = false;
	}
}

const phaseIndex = computed(() => Math.max(0, PHASES.findIndex((phase) => phase.key === (run.value?.phase ?? "starting"))));
const verifyCalls = computed(() => (run.value?.workerCalls ?? []).filter((call) => call.endpoint === "/verify"));
const verifyDone = computed(() => verifyCalls.value.filter((call) => call.outcome !== "pending").length);
const verifyTotal = computed(() => run.value?.ledger?.verifyChunks ?? null);
const calls = computed(() => (run.value?.workerCalls ?? []).filter((call) => call.endpoint !== "/healthz"));
const wake = computed(() => (run.value?.workerCalls ?? []).find((call) => call.endpoint === "/healthz"));
const elapsed = computed(() => (run.value ? now.value - new Date(run.value.startedAt).getTime() : 0));

function phaseLabel(index: number) {
	const phase = PHASES[index]!;
	if (phase.key === "verifying" && verifyTotal.value) return `${phase.label} ${verifyDone.value}/${verifyTotal.value}`;
	return phase.label;
}

watch(
	() => props.runId,
	() => {
		run.value = null;
		cancelling.value = false;
		void tick().finally(() => polling.restart());
	},
);

onMounted(async () => {
	clock = setInterval(() => (now.value = Date.now()), 1000);
	try {
		await tick();
	} catch (err) {
		error.value = err instanceof ApiError ? err.message : "Could not load the run.";
	}
	polling.restart();
});
onBeforeUnmount(() => clearInterval(clock));
</script>

<template>
	<section class="card live" aria-live="polite" aria-label="Run in progress">
		<div class="row between">
			<span class="eyebrow">Live run <span class="mono rid">{{ runId.slice(0, 8) }}</span></span>
			<span class="mono elapsed">{{ formatDuration(elapsed) }}</span>
		</div>

		<ol class="stepper">
			<li v-for="(phase, index) in PHASES" :key="phase.key" :class="{ done: index < phaseIndex, current: index === phaseIndex && run?.status === 'running' }">
				<span class="bullet" aria-hidden="true">{{ index < phaseIndex ? "✓" : index + 1 }}</span>
				<span>{{ phaseLabel(index) }}</span>
			</li>
		</ol>
		<p v-if="wake" class="subtle wake">
			Verifier wake-up: <span class="mono">{{ wake.outcome === "pending" ? "waiting…" : wake.outcome === "complete" ? `answered in ${formatDuration(wake.latencyMs)}` : "no answer" }}</span>
			<span v-if="wake.outcome === 'pending'"> (runs alongside research)</span>
		</p>

		<div class="grid">
			<WorkerCallsTable :calls="calls" compact />
			<div class="side">
				<LedgerBars v-if="run?.ledger" :ledger="run.ledger" />
				<button type="button" class="btn btn-danger btn-sm" :disabled="cancelling || run?.cancelRequested || run?.status !== 'running'" @click="cancel">
					{{ cancelling || run?.cancelRequested ? "Cancelling…" : "Cancel run" }}
				</button>
			</div>
		</div>
		<p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>
	</section>
</template>

<style scoped>
.live {
	gap: var(--space-4);
	border-top: 2px solid var(--accent);
}

.between {
	justify-content: space-between;
}

.rid {
	color: var(--text-subtle);
	margin-left: 6px;
}

.elapsed {
	font-size: 20px;
	color: var(--accent);
}

.stepper {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}

.stepper li {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	padding: 6px 12px 6px 6px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	font-size: 13px;
	color: var(--text-subtle);
}

.bullet {
	display: grid;
	place-items: center;
	width: 20px;
	height: 20px;
	border-radius: 50%;
	background: var(--surface-strong);
	font-family: var(--font-mono);
	font-size: 10.5px;
}

.stepper li.done {
	color: var(--text-muted);
}

.stepper li.done .bullet {
	background: var(--green-soft);
	color: var(--green);
}

.stepper li.current {
	color: var(--text);
	border-color: var(--accent);
	background: var(--accent-soft);
}

.stepper li.current .bullet {
	background: var(--accent);
	color: var(--ink);
	animation: pulse 1.2s ease-in-out infinite;
}

.wake {
	font-size: 12.5px;
}

.grid {
	display: grid;
	grid-template-columns: minmax(0, 1fr) 280px;
	gap: var(--space-4);
	align-items: start;
}

.side {
	display: grid;
	gap: var(--space-4);
	justify-items: start;
}

.side > :first-child {
	width: 100%;
}

@keyframes pulse {
	50% {
		opacity: 0.55;
	}
}

@media (max-width: 860px) {
	.grid {
		grid-template-columns: 1fr;
	}
}
</style>
