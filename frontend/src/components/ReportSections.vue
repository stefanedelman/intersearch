<script setup lang="ts">
import type { Report } from "../api/tracker";
import ReportSectionsV1 from "./ReportSectionsV1.vue";
import ReportSectionsV2 from "./ReportSectionsV2.vue";

// Stored reports keep their schema: 1B tracker runs are v1, orchestrated runs are v2.
defineProps<{ report: Report }>();
</script>

<template>
	<ReportSectionsV1 v-if="report.schemaVersion === 1" :report="report" />
	<ReportSectionsV2 v-else :report="report" />
</template>
