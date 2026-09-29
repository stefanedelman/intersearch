<script setup lang="ts">
import { computed, ref } from "vue";
import { formatDateTime, safeHref, type ReportItem } from "../api/tracker";

// Every string here came from the web. It is rendered with {{ }} interpolation only (never v-html),
// so markup or script in a posting shows up as inert text.
const props = defineProps<{ item: ReportItem }>();
const showEvidence = ref(false);

const sectionLabel = computed(() => ({ new: "New", still: "Still in top K", returned: "Returned" })[props.item.section]);
const rank = computed(() => String(props.item.rank).padStart(2, "0"));
const applyHref = computed(() => safeHref(props.item.applicationUrl));
const bars = computed(() => [
	{ label: "Role", value: props.item.breakdown.role, max: 35 },
	{ label: "Season", value: props.item.breakdown.season, max: 25 },
	{ label: "Location", value: props.item.breakdown.location, max: 20 },
	{ label: "Skills", value: props.item.breakdown.skills, max: 15 },
	{ label: "Fresh", value: props.item.breakdown.freshness, max: 5 },
]);
const factEvidence = computed(() => props.item.evidence.filter((evidence) => evidence.field !== "highlight"));

function hostOf(url: string) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}
</script>

<template>
	<article :class="['card', 'opportunity', `opportunity-${item.section}`]">
		<header class="head">
			<span class="rank mono" :aria-label="`Rank ${item.rank}`">{{ rank }}</span>
			<div class="titles">
				<div class="row tags">
					<span :class="['badge', `badge-${item.section}`]">{{ sectionLabel }}</span>
					<span v-if="!item.reverified" class="badge badge-warn" title="Not re-fetched this run">Not re-verified</span>
				</div>
				<h3>{{ item.title }}</h3>
				<p class="company">
					<span class="company-name">{{ item.company ?? "Unknown company" }}</span>
					<span v-for="location in item.locations" :key="location" class="loc">{{ location }}</span>
				</p>
			</div>
			<div class="score" :title="`Score ${item.score} of 100`">
				<span class="score-value">{{ Math.round(item.score) }}</span>
				<span class="score-max mono">/100</span>
			</div>
		</header>

		<p class="summary">{{ item.summary }}</p>

		<div class="meter" aria-label="Score breakdown">
			<div v-for="bar in bars" :key="bar.label" class="meter-cell" :title="`${bar.label}: ${bar.value} of ${bar.max}`" :style="{ flexGrow: bar.max }">
				<span class="meter-track"><span class="meter-fill" :style="{ width: `${(bar.value / bar.max) * 100}%` }"></span></span>
				<span class="meter-label mono">{{ bar.label }} <b>{{ bar.value }}</b></span>
			</div>
		</div>

		<p class="fit">{{ item.fit }}</p>

		<blockquote v-if="item.agentNote" class="note">
			<span class="eyebrow">Agent's note</span>
			<span>{{ item.agentNote.reason }}</span>
			<span class="quote">“{{ item.agentNote.quote }}”</span>
		</blockquote>

		<ul v-if="item.highlights.length" class="highlights">
			<li v-for="highlight in item.highlights" :key="highlight">{{ highlight }}</li>
		</ul>

		<p v-if="item.unknowns.length" class="subtle">Not stated in the posting: {{ item.unknowns.join(", ") }}.</p>
		<p v-for="note in item.notes" :key="note" class="subtle">{{ note }}</p>

		<footer class="foot">
			<div class="sources">
				<span class="eyebrow">Sources</span>
				<template v-for="source in item.sources" :key="source.sourceDocumentId">
					<a v-if="safeHref(source.url)" :href="safeHref(source.url)!" target="_blank" rel="noopener noreferrer" class="source mono" :title="`${source.title ?? source.url} · fetched ${formatDateTime(source.fetchedAt)}`">
						{{ hostOf(source.url) }}
					</a>
					<span v-else class="source mono">{{ source.url }}</span>
				</template>
			</div>
			<div class="row">
				<button type="button" class="btn btn-ghost btn-sm" :aria-expanded="showEvidence" @click="showEvidence = !showEvidence">
					{{ showEvidence ? "Hide evidence" : "Evidence" }}
				</button>
				<a v-if="applyHref" :href="applyHref" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">Open posting ↗</a>
			</div>
		</footer>

		<div v-if="showEvidence" class="evidence">
			<p class="subtle">Each fact above is backed by an exact quote from a fetched source.</p>
			<dl>
				<template v-for="(evidence, index) in factEvidence" :key="index">
					<dt class="mono">{{ evidence.field.replace("skill:", "skill · ") }}</dt>
					<dd>“{{ evidence.quote }}”</dd>
				</template>
			</dl>
		</div>
	</article>
</template>

<style scoped>
.opportunity {
	gap: var(--space-4);
	border-left: 3px solid var(--blue);
}
.opportunity-new {
	border-left-color: #b9e9b0;
}
.opportunity-returned {
	border-left-color: var(--pink);
}
.opportunity-new .badge-new {
	transform: rotate(-2deg);
}

.opportunity:hover {
	border-color: var(--border-strong);
}

.head {
	display: grid;
	grid-template-columns: auto 1fr auto;
	gap: var(--space-4);
	align-items: start;
}

.rank {
	display: grid;
	place-items: center;
	font-size: 13px;
	color: var(--accent);
	width: 32px;
	height: 34px;
	background: var(--accent-soft);
	border: 1px solid rgba(245, 220, 82, 0.3);
	box-shadow: 2px 2px 0 #000;
}

.titles {
	display: grid;
	gap: 8px;
	min-width: 0;
}

.tags {
	gap: 6px;
}

.titles h3 {
	font-size: 19px;
	font-weight: 600;
	letter-spacing: -0.015em;
	overflow-wrap: anywhere;
}

.company {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 10px;
	font-size: 13px;
	color: var(--text-muted);
}

.company-name {
	color: var(--text);
	font-weight: 500;
}

.loc {
	display: inline-flex;
	align-items: center;
	gap: 10px;
}

.loc::before {
	content: "";
	width: 3px;
	height: 3px;
	border-radius: 50%;
	background: var(--text-faint);
}

.score {
	text-align: right;
	line-height: 1;
}

.score-value {
	display: block;
	font-family: var(--font-sans);
	font-weight: 700;
	letter-spacing: -0.06em;
	font-size: 2.6rem;
	color: var(--accent);
}

.score-max {
	font-size: 11px;
	color: var(--text-subtle);
}

.summary {
	font-size: 14.5px;
	line-height: 1.65;
	color: #d6d8d9;
}

.meter {
	display: flex;
	gap: 6px;
}

.meter-cell {
	display: grid;
	gap: 6px;
	min-width: 0;
	flex-basis: 0;
}

.meter-track {
	height: 5px;
	border-radius: 1px;
	background: rgba(255, 255, 255, 0.07);
	overflow: hidden;
}

.meter-fill {
	display: block;
	height: 100%;
	border-radius: inherit;
	background: var(--accent);
}

.meter-label {
	font-size: 10.5px;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--text-subtle);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}

.meter-label b {
	color: var(--text-muted);
	font-weight: 500;
}

.fit {
	font-size: 13px;
	color: var(--text-muted);
}

.note {
	margin: 0;
	display: grid;
	gap: 4px;
	padding: var(--space-3) var(--space-4);
	border-left: 1px solid var(--border-strong);
	background: linear-gradient(90deg, rgba(255, 255, 255, 0.03), transparent);
	border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
	font-size: 13.5px;
}

.quote {
	color: var(--text-muted);
	font-style: italic;
}

.highlights {
	margin: 0;
	padding: 0;
	list-style: none;
	display: grid;
	gap: 8px;
	font-size: 13.5px;
	color: var(--text-muted);
}

.highlights li {
	position: relative;
	padding-left: 18px;
}

.highlights li::before {
	content: "";
	position: absolute;
	left: 2px;
	top: 0.62em;
	width: 8px;
	height: 1px;
	background: var(--text-faint);
}

.foot {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	align-items: center;
	gap: var(--space-3);
	border-top: 1px solid var(--border);
	padding-top: var(--space-4);
}

.sources {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	align-items: center;
	min-width: 0;
}

.sources .eyebrow {
	margin-right: 4px;
}

.source {
	display: inline-flex;
	align-items: center;
	min-height: 24px;
	max-width: 100%;
	padding: 3px 9px;
	border: 1px solid var(--border);
	border-radius: var(--radius-pill);
	font-size: 11.5px;
	color: var(--text-muted);
	text-decoration: none;
	overflow-wrap: anywhere;
	transition: border-color 0.15s, color 0.15s;
}

a.source:hover {
	color: var(--text);
	border-color: var(--border-strong);
}

.evidence {
	background: var(--surface-solid);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: var(--space-4);
	font-size: 13px;
	display: grid;
	gap: var(--space-3);
}

.evidence dl {
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: 8px var(--space-4);
	margin: 0;
}

.evidence dt {
	font-size: 11px;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: var(--text-subtle);
	padding-top: 2px;
}

.evidence dd {
	margin: 0;
	color: #d6d8d9;
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
		align-items: baseline;
		gap: 4px;
	}

	.score-value {
		display: inline;
		font-size: 2rem;
	}

	.meter {
		flex-wrap: wrap;
	}

	.meter-cell {
		flex-basis: 40%;
	}

	.evidence dl {
		grid-template-columns: 1fr;
		gap: 2px;
	}

	.evidence dd {
		margin-bottom: var(--space-2);
	}
}
</style>
