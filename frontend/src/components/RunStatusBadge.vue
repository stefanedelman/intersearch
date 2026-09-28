<script setup lang="ts">
import { computed } from "vue";
import type { RunStatus } from "../api/tracker";

const props = defineProps<{ status: RunStatus | string; stale?: boolean }>();

const view = computed(() => {
	switch (props.status) {
		case "complete":
			return { label: "Complete", cls: "badge-new" };
		case "partial":
			return { label: props.stale ? "Abandoned" : "Partial", cls: "badge-warn" };
		case "failed":
			return { label: "Failed", cls: "badge-danger" };
		case "running":
			return { label: "Running", cls: "badge-accent" };
		default:
			return { label: props.status, cls: "" };
	}
});
</script>

<template>
	<span :class="['badge', view.cls]">
		<span v-if="status === 'running'" class="pulse" aria-hidden="true"></span>
		{{ view.label }}
	</span>
</template>

<style scoped>
.pulse {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: currentColor;
	animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
	50% {
		opacity: 0.3;
	}
}

@media (prefers-reduced-motion: reduce) {
	.pulse {
		animation: none;
	}
}
</style>
