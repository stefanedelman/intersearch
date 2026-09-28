<script setup lang="ts">
import { useRouter } from "vue-router";
import { useAuth } from "../composables/useAuth";

const router = useRouter();
const { user, isSignedIn, logout } = useAuth();

function signOut() {
	logout();
	void router.push({ name: "login" });
}
</script>

<template>
	<div class="shell">
		<header class="topbar">
			<div class="topbar-inner">
				<RouterLink to="/" class="brand" aria-label="Intersearch home">
					<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
						<rect width="32" height="32" rx="8" fill="currentColor" />
						<circle cx="14" cy="14" r="6.5" fill="none" stroke="#fff" stroke-width="3" />
						<path d="M19 19l6 6" stroke="#fff" stroke-width="3" stroke-linecap="round" />
					</svg>
					<span>Intersearch</span>
				</RouterLink>

				<nav v-if="isSignedIn" class="nav" aria-label="Main">
					<RouterLink to="/" class="nav-link" exact-active-class="active">Dashboard</RouterLink>
					<RouterLink to="/runs" class="nav-link" active-class="active">History</RouterLink>
					<RouterLink to="/account" class="nav-link" active-class="active">Account</RouterLink>
				</nav>

				<div v-if="isSignedIn" class="who">
					<span class="who-name" :title="`Signed in as ${user?.username}`">{{ user?.username }}</span>
					<button type="button" class="btn btn-secondary btn-sm" @click="signOut">Log out</button>
				</div>
			</div>
		</header>

		<main>
			<slot />
		</main>
	</div>
</template>

<style scoped>
.shell {
	min-height: 100vh;
	display: flex;
	flex-direction: column;
}

.topbar {
	background: var(--surface);
	border-bottom: 1px solid var(--border);
	position: sticky;
	top: 0;
	z-index: 10;
}

.topbar-inner {
	max-width: var(--content-width);
	margin: 0 auto;
	padding: 10px var(--space-4);
	display: flex;
	align-items: center;
	gap: var(--space-5);
}

.brand {
	display: inline-flex;
	align-items: center;
	gap: 10px;
	color: var(--accent);
	font-weight: 700;
	font-size: 1.05rem;
	text-decoration: none;
	letter-spacing: -0.01em;
}

.brand span {
	color: var(--text);
}

.nav {
	display: flex;
	gap: var(--space-1);
	flex: 1;
}

.nav-link {
	color: var(--text-muted);
	text-decoration: none;
	font-weight: 540;
	font-size: 0.93rem;
	padding: 6px 10px;
	border-radius: var(--radius-sm);
}

.nav-link:hover {
	color: var(--text);
	background: var(--surface-muted);
}

.nav-link.active {
	color: var(--accent-text);
	background: var(--accent-soft);
}

.who {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	margin-left: auto;
	min-width: 0;
}

.who-name {
	font-weight: 560;
	font-size: 0.9rem;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	max-width: 160px;
}

.btn-sm {
	padding: 5px 12px;
	font-size: 0.86rem;
}

@media (max-width: 640px) {
	.topbar-inner {
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-3);
	}

	.nav {
		order: 3;
		flex-basis: 100%;
	}

	.who-name {
		display: none;
	}
}
</style>
