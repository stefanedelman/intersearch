<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import AuthLayout from "../components/AuthLayout.vue";
import { ApiError } from "../api/client";
import { useAuth } from "../composables/useAuth";

const route = useRoute();
const router = useRouter();
const { login } = useAuth();

const username = ref("");
const password = ref("");
const busy = ref(false);
const error = ref("");
const expired = computed(() => route.query.expired === "1");

async function submit() {
	error.value = "";
	busy.value = true;
	try {
		await login(username.value.trim(), password.value);
		const redirect = typeof route.query.redirect === "string" && route.query.redirect.startsWith("/") ? route.query.redirect : "/";
		await router.replace(redirect);
	} catch (err) {
		error.value = err instanceof ApiError && err.status === 401 ? "Incorrect username or password." : (err as Error).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<AuthLayout title="Log in" subtitle="Use your username or email.">
		<p v-if="expired && !error" class="alert alert-info">Your session ended. Log in again to continue.</p>
		<form class="form" novalidate @submit.prevent="submit">
			<div class="field">
				<label for="login-username">Username or email</label>
				<input id="login-username" v-model="username" type="text" autocomplete="username" required autofocus />
			</div>
			<div class="field">
				<label for="login-password">Password</label>
				<input id="login-password" v-model="password" type="password" autocomplete="current-password" required />
			</div>
			<p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>
			<button class="btn btn-primary" type="submit" :disabled="busy || !username || !password">
				{{ busy ? "Logging in…" : "Log in" }}
			</button>
		</form>
		<p class="subtle">No account yet? <RouterLink to="/register">Create one</RouterLink></p>
	</AuthLayout>
</template>
