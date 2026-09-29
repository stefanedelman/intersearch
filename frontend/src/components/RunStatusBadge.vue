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
	<span :class="['badge', 'badge-dot', view.cls, { running: status === 'running' }]">{{ view.label }}</span>
</template>

<style scoped>
.running::before {
	animation: pulse 1.2s ease-in-out infinite;
	box-shadow: 0 0 8px currentColor;
}

@keyframes pulse {
	50% {
		opacity: 0.25;
	}
}
</style>
