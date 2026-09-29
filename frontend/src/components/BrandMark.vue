<template>
	<svg class="mark" viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
		<defs>
			<linearGradient id="mark-fill" x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stop-color="#ffffff" stop-opacity="0.16" />
				<stop offset="1" stop-color="#ffffff" stop-opacity="0.02" />
			</linearGradient>
		</defs>
		<rect x="0.5" y="0.5" width="31" height="31" rx="5" fill="url(#mark-fill)" stroke="#f5dc52" stroke-opacity="0.6" />
		<circle cx="14.5" cy="14.5" r="6" fill="none" stroke="#f5dc52" stroke-width="2.2" />
		<path d="M19 19l5 5" stroke="#f5dc52" stroke-width="2.2" stroke-linecap="round" />
	</svg>
</template>

<style scoped>
.mark {
	flex: none;
}
</style>
