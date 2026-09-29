<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "../composables/useAuth";

const router = useRouter();
const { user, update, verifyPassword, deleteAccount, logout } = useAuth();

const email = ref(user.value?.email ?? "");
const emailBusy = ref(false);
const emailMessage = ref<{ kind: "success" | "error"; text: string } | null>(null);

const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const passwordBusy = ref(false);
const passwordMessage = ref<{ kind: "success" | "error"; text: string } | null>(null);

const deleteConfirm = ref("");
const deleteBusy = ref(false);
const deleteError = ref("");

const initial = computed(() => (user.value?.username ?? "?").slice(0, 1).toUpperCase());

function formatDate(value?: string) {
	return value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "long" }) : "";
}

async function saveEmail() {
	emailMessage.value = null;
	const value = email.value.trim();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
		emailMessage.value = { kind: "error", text: "Enter a valid email address." };
		return;
	}
	emailBusy.value = true;
	try {
		await update({ email: value });
		emailMessage.value = { kind: "success", text: "Email updated." };
	} catch (err) {
		emailMessage.value = { kind: "error", text: (err as Error).message };
	} finally {
		emailBusy.value = false;
	}
}

async function savePassword() {
	passwordMessage.value = null;
	if (newPassword.value.length < 8) {
		passwordMessage.value = { kind: "error", text: "Use at least 8 characters for the new password." };
		return;
	}
	if (newPassword.value !== confirmPassword.value) {
		passwordMessage.value = { kind: "error", text: "New passwords do not match." };
		return;
	}
	passwordBusy.value = true;
	try {
		if (!(await verifyPassword(currentPassword.value))) {
			passwordMessage.value = { kind: "error", text: "Current password is incorrect." };
			return;
		}
		await update({ password: newPassword.value });
		currentPassword.value = newPassword.value = confirmPassword.value = "";
		passwordMessage.value = { kind: "success", text: "Password changed. Use it the next time you log in." };
	} catch (err) {
		passwordMessage.value = { kind: "error", text: (err as Error).message };
	} finally {
		passwordBusy.value = false;
	}
}

async function removeAccount() {
	deleteError.value = "";
	deleteBusy.value = true;
	try {
		await deleteAccount();
		await router.replace({ name: "register" });
	} catch (err) {
		deleteError.value = (err as Error).message;
	} finally {
		deleteBusy.value = false;
	}
}

function signOut() {
	logout();
	void router.push({ name: "login" });
}
</script>

<template>
	<div class="page narrow">
		<header class="page-header">
			<div>
				<p class="eyebrow">Settings</p>
				<h1 class="display">Account</h1>
				<p class="lead">Manage how you sign in to Intersearch.</p>
			</div>
			<button type="button" class="btn btn-secondary btn-sm" @click="signOut">Log out</button>
		</header>

		<section class="card identity" aria-labelledby="identity-heading">
			<span class="avatar" aria-hidden="true">{{ initial }}</span>
			<div class="identity-text">
				<h2 id="identity-heading">{{ user?.username }}</h2>
				<p class="muted">{{ user?.email ?? "No email on file" }}</p>
			</div>
			<span class="mono since">Member since {{ formatDate(user?.createdAt) }}</span>
		</section>

		<section class="card setting" aria-labelledby="email-heading">
			<div class="setting-intro">
				<h2 id="email-heading">Email</h2>
				<p class="subtle">Optional. Used to log in instead of your username.</p>
			</div>
			<form class="form" novalidate @submit.prevent="saveEmail">
				<div class="field">
					<label for="acct-email">Email address</label>
					<input id="acct-email" v-model="email" type="email" autocomplete="email" placeholder="you@example.com" />
				</div>
				<p v-if="emailMessage" :class="['alert', `alert-${emailMessage.kind}`]" role="status">{{ emailMessage.text }}</p>
				<div class="actions"><button class="btn btn-primary btn-sm" type="submit" :disabled="emailBusy">{{ emailBusy ? "Saving…" : "Save email" }}</button></div>
			</form>
		</section>

		<section class="card setting" aria-labelledby="password-heading">
			<div class="setting-intro">
				<h2 id="password-heading">Password</h2>
				<p class="subtle">Confirm your current password to set a new one.</p>
			</div>
			<form class="form" novalidate @submit.prevent="savePassword">
				<input type="text" autocomplete="username" :value="user?.username" hidden readonly />
				<div class="field">
					<label for="acct-current">Current password</label>
					<input id="acct-current" v-model="currentPassword" type="password" autocomplete="current-password" />
				</div>
				<div class="field-pair">
					<div class="field">
						<label for="acct-new">New password</label>
						<input id="acct-new" v-model="newPassword" type="password" autocomplete="new-password" />
					</div>
					<div class="field">
						<label for="acct-confirm">Confirm new password</label>
						<input id="acct-confirm" v-model="confirmPassword" type="password" autocomplete="new-password" />
					</div>
				</div>
				<p v-if="passwordMessage" :class="['alert', `alert-${passwordMessage.kind}`]" role="status">{{ passwordMessage.text }}</p>
				<div class="actions">
					<button class="btn btn-primary btn-sm" type="submit" :disabled="passwordBusy || !currentPassword || !newPassword">
						{{ passwordBusy ? "Saving…" : "Change password" }}
					</button>
				</div>
			</form>
		</section>

		<section class="card setting danger-zone" aria-labelledby="delete-heading">
			<div class="setting-intro">
				<h2 id="delete-heading">Delete account</h2>
				<p class="subtle">Permanently deletes your account, tracker history, and saved reports. This cannot be undone.</p>
			</div>
			<form class="form" novalidate @submit.prevent="removeAccount">
				<div class="field">
					<label for="acct-delete">Type <span class="mono">{{ user?.username }}</span> to confirm</label>
					<input id="acct-delete" v-model="deleteConfirm" type="text" autocomplete="off" />
				</div>
				<p v-if="deleteError" class="alert alert-error" role="alert">{{ deleteError }}</p>
				<div class="actions">
					<button class="btn btn-danger btn-sm" type="submit" :disabled="deleteBusy || deleteConfirm !== user?.username">
						{{ deleteBusy ? "Deleting…" : "Delete my account" }}
					</button>
				</div>
			</form>
		</section>
	</div>
</template>

<style scoped>
.narrow {
	max-width: 820px;
}

.identity {
	grid-template-columns: auto 1fr auto;
	align-items: center;
	gap: var(--space-4);
}

.avatar {
	display: grid;
	place-items: center;
	width: 48px;
	height: 48px;
	border-radius: 50%;
	background: linear-gradient(135deg, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.03));
	border: 1px solid var(--border-strong);
	font-family: var(--font-display);
	font-size: 1.6rem;
}

.identity-text {
	display: grid;
	gap: 2px;
	min-width: 0;
}

.identity-text h2 {
	font-size: 17px;
}

.since {
	font-size: 11px;
	letter-spacing: 0.06em;
	text-transform: uppercase;
	color: var(--text-subtle);
}

.setting {
	grid-template-columns: 220px 1fr;
	gap: var(--space-6);
	align-items: start;
}

.setting-intro {
	display: grid;
	gap: 6px;
}

.field-pair {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: var(--space-3);
}

.actions {
	display: flex;
	justify-content: flex-end;
}

.danger-zone {
	border-color: rgba(255, 110, 110, 0.18);
	background: linear-gradient(180deg, rgba(255, 77, 77, 0.04), transparent 60%);
}

@media (max-width: 720px) {
	.identity {
		grid-template-columns: auto 1fr;
	}

	.since {
		grid-column: 1 / -1;
	}

	.setting {
		grid-template-columns: 1fr;
		gap: var(--space-4);
	}

	.field-pair {
		grid-template-columns: 1fr;
	}
}
</style>
