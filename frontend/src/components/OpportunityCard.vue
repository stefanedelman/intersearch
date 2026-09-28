<script setup lang="ts">
import { computed, ref } from "vue";
import { formatDateTime, safeHref, type ReportItem } from "../api/tracker";

// Every string here came from the web. It is rendered with {{ }} interpolation only (never v-html),
// so markup or script in a posting shows up as inert text.
const props = defineProps<{ item: ReportItem }>();
const showEvidence = ref(false);

const sectionLabel = computed(() => ({ new: "New", still: "Still in top K", returned: "Returned" })[props.item.section]);
const applyHref = computed(() => safeHref(props.item.applicationUrl));
const bars = computed(() => [
	{ label: "Role", value: props.item.breakdown.role, max: 35 },
	{ label: "Season", value: props.item.breakdown.season, max: 25 },
	{ label: "Location", value: props.item.breakdown.location, max: 20 },
	{ label: "Skills", value: props.item.breakdown.skills, max: 15 },
	{ label: "Fresh", value: props.item.breakdown.freshness, max: 5 },
]);
const factEvidence = computed(() => props.item.evidence.filter((evidence) => evidence.field !== "highlight"));
</script>

<template>
	<article class="card card-compact opportunity">
		<header class="head">
			<div class="rank" :aria-label="`Rank ${item.rank}`">#{{ item.rank }}</div>
			<div class="titles">
				<div class="row">
					<span :class="['badge', `badge-${item.section}`]">{{ sectionLabel }}</span>
					<span v-if="!item.reverified" class="badge badge-warn" title="Not re-fetched this run">Not re-verified</span>
				</div>
				<h3>{{ item.title }}</h3>
				<p class="muted company">
					{{ item.company ?? "Unknown company" }}<span v-if="item.locations.length"> · {{ item.locations.join(" · ") }}</span>
				</p>
			</div>
			<div class="score" :title="`Score ${item.score} of 100`">
				<span class="score-value">{{ Math.round(item.score) }}</span>
				<span class="subtle">/ 100</span>
			</div>
		</header>

		<p class="summary">{{ item.summary }}</p>
		<p class="fit"><strong>Fit:</strong> {{ item.fit }}</p>

		<blockquote v-if="item.agentNote" class="note">
			<span class="note-label">Agent's note</span>
			{{ item.agentNote.reason }}
			<span class="subtle">— quoted: “{{ item.agentNote.quote }}”</span>
		</blockquote>

		<ul v-if="item.highlights.length" class="highlights">
			<li v-for="highlight in item.highlights" :key="highlight">“{{ highlight }}”</li>
		</ul>

		<div class="breakdown" aria-label="Score breakdown">
			<div v-for="bar in bars" :key="bar.label" class="bar">
				<span class="bar-label">{{ bar.label }}</span>
				<span class="bar-track"><span class="bar-fill" :style="{ width: `${(bar.value / bar.max) * 100}%` }"></span></span>
				<span class="bar-value">{{ bar.value }}</span>
			</div>
		</div>

		<p v-if="item.unknowns.length" class="subtle">Not stated in the posting: {{ item.unknowns.join(", ") }}.</p>
		<p v-for="note in item.notes" :key="note" class="subtle">{{ note }}</p>

		<footer class="foot">
			<div class="sources">
				<span class="subtle">Sources:</span>
				<template v-for="source in item.sources" :key="source.sourceDocumentId">
					<a v-if="safeHref(source.url)" :href="safeHref(source.url)!" target="_blank" rel="noopener noreferrer" class="source-link" :title="`Fetched ${formatDateTime(source.fetchedAt)}`">
						{{ source.title ?? source.url }}
					</a>
					<span v-else class="source-link">{{ source.url }}</span>
				</template>
			</div>
			<div class="row">
				<button type="button" class="btn-link" :aria-expanded="showEvidence" @click="showEvidence = !showEvidence">
					{{ showEvidence ? "Hide evidence" : "Show evidence" }}
				</button>
				<a v-if="applyHref" :href="applyHref" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">Open posting</a>
			</div>
		</footer>

		<div v-if="showEvidence" class="evidence">
			<p class="subtle">Each fact above is backed by an exact quote from a fetched source.</p>
			<dl>
				<template v-for="(evidence, index) in factEvidence" :key="index">
					<dt>{{ evidence.field.replace("skill:", "skill: ") }}</dt>
					<dd>“{{ evidence.quote }}”</dd>
				</template>
			</dl>
		</div>
	</article>
</template>

<style scoped>
.opportunity {
	gap: var(--space-3);
}

.head {
	display: grid;
	grid-template-columns: auto 1fr auto;
	gap: var(--space-3);
	align-items: start;
}

.rank {
	font-size: 1.3rem;
	font-weight: 700;
	color: var(--accent);
	min-width: 2.2rem;
}

.titles {
	display: grid;
	gap: 4px;
	min-width: 0;
}

.titles h3 {
	font-size: 1.05rem;
	overflow-wrap: anywhere;
}

.company {
	font-size: 0.9rem;
}

.score {
	text-align: right;
	line-height: 1.1;
}

.score-value {
	display: block;
	font-size: 1.5rem;
	font-weight: 700;
}

.summary {
	font-size: 0.95rem;
}

.fit {
	font-size: 0.9rem;
	color: var(--text-muted);
}

.note {
	margin: 0;
	padding: var(--space-2) var(--space-3);
	border-left: 3px solid var(--accent);
	background: var(--accent-soft);
	border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
	font-size: 0.9rem;
}

.note-label {
	display: block;
	font-size: 0.75rem;
	font-weight: 650;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	color: var(--accent-text);
}

.highlights {
	margin: 0;
	padding-left: 1.1rem;
	color: var(--text-muted);
	font-size: 0.9rem;
	display: grid;
	gap: 4px;
}

.breakdown {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
	gap: 6px var(--space-4);
}

.bar {
	display: grid;
	grid-template-columns: 58px 1fr 30px;
	align-items: center;
	gap: var(--space-2);
	font-size: 0.8rem;
	color: var(--text-muted);
}

.bar-track {
	height: 6px;
	background: var(--surface-muted);
	border-radius: 999px;
	overflow: hidden;
}

.bar-fill {
	display: block;
	height: 100%;
	background: var(--accent);
	border-radius: 999px;
}

.bar-value {
	text-align: right;
	font-variant-numeric: tabular-nums;
}

.foot {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	align-items: center;
	gap: var(--space-2);
	border-top: 1px solid var(--border);
	padding-top: var(--space-3);
}

.sources {
	display: flex;
	flex-wrap: wrap;
	gap: 4px var(--space-3);
	align-items: baseline;
	font-size: 0.85rem;
	min-width: 0;
}

.source-link {
	overflow-wrap: anywhere;
}

.btn-sm {
	padding: 5px 12px;
	font-size: 0.86rem;
}

.evidence {
	background: var(--surface-muted);
	border-radius: var(--radius);
	padding: var(--space-3);
	font-size: 0.86rem;
}

.evidence dl {
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: 6px var(--space-3);
	margin: var(--space-2) 0 0;
}

.evidence dt {
	color: var(--text-muted);
	font-weight: 560;
}

.evidence dd {
	margin: 0;
	overflow-wrap: anywhere;
}

@media (max-width: 640px) {
	.head {
		grid-template-columns: auto 1fr;
	}

	.score {
		grid-column: 2;
		text-align: left;
		display: flex;
		gap: 4px;
		align-items: baseline;
	}

	.evidence dl {
		grid-template-columns: 1fr;
	}
}
</style>
