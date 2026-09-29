<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import AuthLayout from "../components/AuthLayout.vue";
import { useAuth } from "../composables/useAuth";

const router = useRouter();
const { register } = useAuth();

const username = ref("");
const email = ref("");
const password = ref("");
const confirm = ref("");
const busy = ref(false);
const error = ref("");
const touched = ref(false);

const problems = computed(() => {
	const list: Record<string, string> = {};
	const name = username.value.trim();
	if (name.length < 3 || name.length > 32) list.username = "Use 3–32 characters.";
	else if (!/^[A-Za-z0-9_.-]+$/.test(name)) list.username = "Letters, numbers, dots, dashes, and underscores only.";
	if (email.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim())) list.email = "Enter a valid email, or leave it blank.";
	if (password.value.length < 8) list.password = "Use at least 8 characters.";
	if (confirm.value !== password.value) list.confirm = "Passwords do not match.";
	return list;
});

async function submit() {
	touched.value = true;
	error.value = "";
	if (Object.keys(problems.value).length) return;
	busy.value = true;
	try {
		await register({
			username: username.value.trim(),
			password: password.value,
			...(email.value.trim() ? { email: email.value.trim() } : {}),
		});
		await router.replace("/");
	} catch (err) {
		error.value = (err as Error).message;
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<AuthLayout title="Create your account" subtitle="Email is optional. You can add one later.">
		<form class="form" novalidate @submit.prevent="submit">
			<div class="field">
				<label for="reg-username">Username</label>
				<input
					id="reg-username"
					v-model="username"
					type="text"
					autocomplete="username"
					:aria-invalid="touched && !!problems.username"
					aria-describedby="reg-username-hint"
					required
					autofocus
				/>
				<span id="reg-username-hint" :class="['hint', { error: touched && problems.username }]">{{ touched && problems.username ? problems.username : "3–32 characters." }}</span>
			</div>
			<div class="field">
				<label for="reg-email">Email <span class="subtle">(optional)</span></label>
				<input id="reg-email" v-model="email" type="email" autocomplete="email" placeholder="you@example.com" :aria-invalid="touched && !!problems.email" />
				<span v-if="touched && problems.email" class="hint error">{{ problems.email }}</span>
			</div>
			<div class="field-pair">
				<div class="field">
					<label for="reg-password">Password</label>
					<input id="reg-password" v-model="password" type="password" autocomplete="new-password" :aria-invalid="touched && !!problems.password" required />
					<span :class="['hint', { error: touched && problems.password }]">{{ touched && problems.password ? problems.password : "At least 8 characters." }}</span>
				</div>
				<div class="field">
					<label for="reg-confirm">Confirm</label>
					<input id="reg-confirm" v-model="confirm" type="password" autocomplete="new-password" :aria-invalid="touched && !!problems.confirm" required />
					<span v-if="touched && problems.confirm" class="hint error">{{ problems.confirm }}</span>
				</div>
			</div>
			<p v-if="error" class="alert alert-error" role="alert">{{ error }}</p>
			<button class="btn btn-primary btn-block" type="submit" :disabled="busy">{{ busy ? "Creating account…" : "Create account" }}</button>
		</form>
		<p class="subtle foot">Already have an account? <RouterLink to="/login">Log in</RouterLink></p>
	</AuthLayout>
</template>

<style scoped>
.field-pair {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: var(--space-3);
	align-items: start;
}

.foot {
	text-align: center;
}

@media (max-width: 480px) {
	.field-pair {
		grid-template-columns: 1fr;
		gap: var(--space-4);
	}
}
</style>
