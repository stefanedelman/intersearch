<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "../composables/useAuth";
import BrandMark from "./BrandMark.vue";

const route = useRoute();
const router = useRouter();
const { user, isSignedIn, logout } = useAuth();

const nav = [
	{ to: "/", label: "Dashboard", icon: "grid", match: (path: string) => path === "/" },
	{ to: "/runs", label: "Run history", icon: "clock", match: (path: string) => path.startsWith("/runs") },
	{ to: "/account", label: "Account", icon: "user", match: (path: string) => path.startsWith("/account") },
] as const;

const initial = computed(() => (user.value?.username ?? "?").slice(0, 1).toUpperCase());

function signOut() {
	logout();
	void router.push({ name: "login" });
}
</script>

<template>
	<div :class="['shell', { 'shell-app': isSignedIn }]">
		<div class="glow" aria-hidden="true"></div>

		<aside v-if="isSignedIn" class="sidebar">
			<RouterLink to="/" class="brand" aria-label="Intersearch home">
				<BrandMark />
				<span>Intersearch</span>
			</RouterLink>

			<nav class="nav" aria-label="Main">
				<RouterLink v-for="item in nav" :key="item.to" :to="item.to" :class="['nav-link', { active: item.match(route.path) }]" :aria-current="item.match(route.path) ? 'page' : undefined">
					<svg v-if="item.icon === 'grid'" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
						<rect x="3" y="3" width="6" height="6" rx="1.5" /><rect x="11" y="3" width="6" height="6" rx="1.5" /><rect x="3" y="11" width="6" height="6" rx="1.5" /><rect x="11" y="11" width="6" height="6" rx="1.5" />
					</svg>
					<svg v-else-if="item.icon === 'clock'" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
						<circle cx="10" cy="10" r="7" /><path d="M10 6.5V10l2.5 1.5" />
					</svg>
					<svg v-else viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
						<circle cx="10" cy="7" r="3.2" /><path d="M4 17c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5" />
					</svg>
					<span>{{ item.label }}</span>
				</RouterLink>
			</nav>

			<div class="sidebar-foot">
				<div class="who">
					<span class="avatar" aria-hidden="true">{{ initial }}</span>
					<div class="who-text">
						<span class="who-name">{{ user?.username }}</span>
						<span class="who-meta">Signed in</span>
					</div>
				</div>
				<button type="button" class="btn btn-ghost btn-sm logout" @click="signOut">Log out</button>
			</div>
		</aside>

		<main class="main">
			<slot />
		</main>
	</div>
</template>

<style scoped>
.shell {
	position: relative;
	min-height: 100vh;
	isolation: isolate;
}

/* Soft light from above, like Resend's hero. */
.glow {
	position: fixed;
	inset: -30vh -10vw auto;
	height: 70vh;
	z-index: -1;
	pointer-events: none;
	background: radial-gradient(60% 60% at 50% 0%, rgba(225, 242, 254, 0.09), rgba(0, 0, 0, 0) 70%);
}

.shell-app .glow {
	left: var(--sidebar-width);
}

.sidebar {
	position: fixed;
	inset: 0 auto 0 0;
	width: var(--sidebar-width);
	display: flex;
	flex-direction: column;
	gap: var(--space-6);
	padding: var(--space-5) var(--space-3);
	border-right: 1px solid var(--border);
	background: rgba(0, 0, 0, 0.6);
	backdrop-filter: blur(12px);
	z-index: 20;
}

.brand {
	display: inline-flex;
	align-items: center;
	gap: 10px;
	padding: 0 var(--space-2);
	color: var(--text);
	font-weight: 600;
	font-size: 15px;
	letter-spacing: -0.01em;
	text-decoration: none;
}

.nav {
	display: grid;
	gap: 2px;
}

.nav-link {
	display: flex;
	align-items: center;
	gap: 10px;
	height: 34px;
	padding: 0 var(--space-3);
	border-radius: var(--radius-sm);
	color: var(--text-muted);
	font-size: 13.5px;
	font-weight: 500;
	text-decoration: none;
	transition: background 0.15s, color 0.15s;
}

.nav-link svg {
	fill: none;
	stroke: currentColor;
	stroke-width: 1.5;
	stroke-linecap: round;
	stroke-linejoin: round;
	flex: none;
}

.nav-link:hover {
	color: var(--text);
	background: var(--surface-hover);
}

.nav-link.active {
	color: var(--text);
	background: var(--surface-strong);
	box-shadow: inset 0 0 0 1px var(--border);
}

.sidebar-foot {
	margin-top: auto;
	display: grid;
	gap: var(--space-2);
	padding-top: var(--space-4);
	border-top: 1px solid var(--border);
}

.who {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 0 var(--space-2);
	min-width: 0;
}

.avatar {
	flex: none;
	display: grid;
	place-items: center;
	width: 30px;
	height: 30px;
	border-radius: 50%;
	background: linear-gradient(135deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.04));
	border: 1px solid var(--border-strong);
	font-size: 12.5px;
	font-weight: 600;
}

.who-text {
	display: grid;
	min-width: 0;
	line-height: 1.3;
}

.who-name {
	font-size: 13px;
	font-weight: 500;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.who-meta {
	font-family: var(--font-mono);
	font-size: 10.5px;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: var(--text-subtle);
}

.logout {
	justify-content: flex-start;
}

.shell-app .main {
	margin-left: var(--sidebar-width);
}

@media (max-width: 900px) {
	.sidebar {
		position: sticky;
		top: 0;
		inset: 0 0 auto 0;
		width: auto;
		height: auto;
		flex-direction: row;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-right: none;
		border-bottom: 1px solid var(--border);
	}

	.nav {
		order: 3;
		flex-basis: 100%;
		display: flex;
		gap: var(--space-1);
		overflow-x: auto;
	}

	.nav-link {
		height: 32px;
		white-space: nowrap;
	}

	.sidebar-foot {
		margin: 0 0 0 auto;
		padding: 0;
		border: none;
		display: flex;
		align-items: center;
	}

	.who-text {
		display: none;
	}

	.shell-app .main {
		margin-left: 0;
	}

	.shell-app .glow {
		left: -10vw;
	}
}
</style>
