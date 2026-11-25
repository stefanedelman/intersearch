<script setup lang="ts">
import { CLAIM_LABEL_TEXT, hostOf, safeHref, type ClaimLabel } from "../api/tracker";

// Claim text and evidence come from the researcher and the verifier, which read web pages.
// They are rendered with {{ }} interpolation only (never v-html), so markup stays inert text.
defineProps<{ claims: { claimId: string; text: string; sourceUrl: string; label: ClaimLabel; evidence: string | null }[] }>();

const TITLES: Record<ClaimLabel, string> = {
	supported: "The verifier found this on the cited page; the excerpt below was checked by code.",
	unsupported: "The verifier read the cited page and did not find support for this.",
	unreachable: "The cited page could not be fetched (blocked address, error, or timeout).",
	unverified: "Not checked: the verifier was unavailable, out of budget, or the run stopped first.",
};
</script>

<template>
	<ul class="claims">
		<li v-for="claim in claims" :key="claim.claimId" :class="['claim', `claim-${claim.label}`]">
			<span :class="['label', `label-${claim.label}`]" :title="TITLES[claim.label]">{{ CLAIM_LABEL_TEXT[claim.label] }}</span>
			<div class="body">
				<p class="text">{{ claim.text }}</p>
				<blockquote v-if="claim.label === 'supported' && claim.evidence" class="evidence">“{{ claim.evidence }}”</blockquote>
				<a v-if="safeHref(claim.sourceUrl)" :href="safeHref(claim.sourceUrl)!" target="_blank" rel="noopener noreferrer" class="source mono" :title="claim.sourceUrl">{{ hostOf(claim.sourceUrl) }} ↗</a>
				<span v-else class="source mono">{{ claim.sourceUrl }}</span>
			</div>
		</li>
	</ul>
</template>

<style scoped>
.claims {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 2px;
}

.claim {
	display: grid;
	grid-template-columns: 112px 1fr;
	gap: var(--space-3);
	align-items: start;
	padding: 10px 0;
	border-top: 1px solid var(--border);
}

.claim:first-child {
	border-top: none;
}

.label {
	display: inline-flex;
	justify-content: center;
	align-items: center;
	height: 22px;
	padding: 0 8px;
	border-radius: var(--radius-pill);
	border: 1px solid var(--border);
	font-family: var(--font-mono);
	font-size: 10px;
	font-weight: 500;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	cursor: help;
}

.label-supported {
	background: var(--green-soft);
	border-color: rgba(96, 254, 167, 0.3);
	color: var(--green);
}

.label-unsupported {
	background: var(--red-soft);
	border-color: rgba(255, 110, 110, 0.3);
	color: var(--red);
}

.label-unreachable {
	background: var(--surface-strong);
	color: var(--text-muted);
}

.label-unverified {
	background: var(--orange-soft);
	border-color: rgba(255, 170, 60, 0.3);
	color: var(--orange);
}

.body {
	display: grid;
	gap: 6px;
	min-width: 0;
}

.text {
	font-size: 14px;
	line-height: 1.5;
	overflow-wrap: anywhere;
}

.claim-unsupported .text {
	color: var(--text-muted);
}

.evidence {
	margin: 0;
	padding: 6px 12px;
	border-left: 2px solid var(--green);
	background: linear-gradient(90deg, var(--green-soft), transparent);
	font-size: 13px;
	font-style: italic;
	color: #d6d8d9;
	overflow-wrap: anywhere;
}

.source {
	justify-self: start;
	font-size: 11px;
	color: var(--text-subtle);
	text-decoration: none;
	overflow-wrap: anywhere;
}

a.source:hover {
	color: var(--text);
}

@media (max-width: 640px) {
	.claim {
		grid-template-columns: 1fr;
		gap: 6px;
	}
	.label {
		justify-self: start;
	}
}
</style>
