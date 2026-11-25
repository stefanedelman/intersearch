<script setup lang="ts">
import { formatDuration, WORKER_TEXT, type WorkerCall } from "../api/tracker";

// Every request the orchestrator made to a worker, with each attempt. Latency is measured by the
// orchestrator (caller side), the authoritative cross-service number.
defineProps<{ calls: WorkerCall[]; compact?: boolean }>();

const OUTCOME: Record<WorkerCall["outcome"], { text: string; cls: string }> = {
	pending: { text: "In flight", cls: "badge-accent" },
	complete: { text: "Complete", cls: "badge-new" },
	partial: { text: "Partial", cls: "badge-warn" },
	failed: { text: "Failed", cls: "badge-danger" },
	malformed: { text: "Rejected answer", cls: "badge-danger" },
	unanswered: { text: "No answer", cls: "badge-danger" },
	refused_budget: { text: "Not sent", cls: "" },
	rejected: { text: "Refused", cls: "badge-danger" },
};

function attemptText(status: number | string) {
	return typeof status === "number" ? String(status) : status.replace("_", " ");
}

function attemptClass(status: number | string) {
	if (status === 200) return "ok";
	if (status === "timeout" || status === 503 || status === 502 || status === 504) return "retry";
	return "bad";
}

function charged(call: WorkerCall) {
	const usage = call.chargedUsage;
	if (!usage) return "—";
	return `${usage.steps} / ${usage.fetches} / ${usage.tokens.toLocaleString()}`;
}
</script>

<template>
	<div :class="['table-wrap', { compact }]">
		<table class="calls">
			<thead>
				<tr>
					<th scope="col">Request</th>
					<th scope="col">Outcome</th>
					<th scope="col">Attempts</th>
					<th scope="col" class="num">Latency</th>
					<th v-if="!compact" scope="col" class="num" title="Charged to the run budget: steps / fetches / tokens">Charged</th>
					<th v-if="!compact" scope="col">Detail</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="call in calls" :key="call.requestId">
					<td>
						<span class="who">{{ WORKER_TEXT[call.service] }}</span>
						<span class="mono endpoint">{{ call.endpoint }}</span>
						<span v-if="!compact" class="mono rid" :title="call.requestId">{{ call.requestId.slice(0, 8) }}</span>
					</td>
					<td>
						<span :class="['badge', 'badge-dot', OUTCOME[call.outcome].cls, { pulsing: call.outcome === 'pending' }]">{{ OUTCOME[call.outcome].text }}</span>
					</td>
					<td class="attempts mono">
						<template v-if="call.attemptLog?.length">
							<span v-for="(attempt, index) in call.attemptLog" :key="index" :class="['attempt', attemptClass(attempt.status)]" :title="`Attempt ${attempt.attempt}: ${attempt.latencyMs} ms${attempt.waitMs !== null ? `, then waited ${attempt.waitMs} ms` : ''}${attempt.errorCode ? ` (${attempt.errorCode})` : ''}`">
								{{ attemptText(attempt.status) }}<span v-if="index < call.attemptLog.length - 1" class="arrow">→</span>
							</span>
						</template>
						<span v-else class="dim">{{ call.outcome === "pending" ? "…" : "—" }}</span>
					</td>
					<td class="num mono dim">{{ formatDuration(call.latencyMs) }}</td>
					<td v-if="!compact" class="num mono dim">{{ charged(call) }}<span v-if="call.chargedUsage?.overrun" class="overrun" title="The worker reported more than its share"> overrun</span></td>
					<td v-if="!compact" class="detail">{{ call.errorMessage ?? "" }}</td>
				</tr>
				<tr v-if="!calls.length">
					<td :colspan="compact ? 4 : 6" class="muted">No worker requests yet.</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>

<style scoped>
.calls td {
	font-size: 12.5px;
	vertical-align: middle;
}

.compact th,
.compact td {
	padding: 10px 10px;
}

.compact .attempts {
	white-space: normal;
}

.compact .badge {
	font-size: 9.5px;
	padding: 0 6px;
}

.who {
	font-weight: 500;
	margin-right: 6px;
}

.endpoint {
	color: var(--text-muted);
	font-size: 11.5px;
}

.rid {
	display: block;
	font-size: 10.5px;
	color: var(--text-faint);
}

.attempts {
	white-space: nowrap;
	font-size: 11.5px;
}

.attempt.ok {
	color: var(--green);
}

.attempt.retry {
	color: var(--orange);
}

.attempt.bad {
	color: var(--red);
}

.arrow {
	margin: 0 4px;
	color: var(--text-faint);
}

.num {
	text-align: right;
}

.dim {
	color: var(--text-muted);
	white-space: nowrap;
}

.detail {
	color: var(--text-muted);
	max-width: 320px;
	overflow-wrap: anywhere;
}

.overrun {
	color: var(--red);
}

.pulsing::before {
	animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
	50% {
		opacity: 0.25;
	}
}
</style>
