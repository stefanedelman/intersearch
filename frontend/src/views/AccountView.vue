<script setup lang="ts">
import { ref } from "vue";
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

function formatDate(value?: string) {
	return value ? new Date(value).toLocaleString() : "";
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
	<div class="page">
		<div class="page-header">
			<div>
				<h1>Account</h1>
				<p>Manage how you sign in to Intersearch.</p>
			</div>
			<button type="button" class="btn btn-secondary" @click="signOut">Log out</button>
		</div>

		<section class="card" aria-labelledby="identity-heading">
			<h2 id="identity-heading">Signed in as</h2>
			<dl class="meta-list">
				<dt>Username</dt>
				<dd>{{ user?.username }}</dd>
				<dt>Email</dt>
				<dd>{{ user?.email ?? "Not set" }}</dd>
				<dt>Member since</dt>
				<dd>{{ formatDate(user?.createdAt) }}</dd>
			</dl>
		</section>

		<div class="grid-2">
			<section class="card" aria-labelledby="email-heading">
				<h2 id="email-heading">Email</h2>
				<form class="form" novalidate @submit.prevent="saveEmail">
					<div class="field">
						<label for="acct-email">Email address</label>
						<input id="acct-email" v-model="email" type="email" autocomplete="email" />
					</div>
					<p v-if="emailMessage" :class="['alert', `alert-${emailMessage.kind}`]" role="status">{{ emailMessage.text }}</p>
					<div><button class="btn btn-primary" type="submit" :disabled="emailBusy">{{ emailBusy ? "Saving…" : "Save email" }}</button></div>
				</form>
			</section>

			<section class="card" aria-labelledby="password-heading">
				<h2 id="password-heading">Password</h2>
				<form class="form" novalidate @submit.prevent="savePassword">
					<input type="text" autocomplete="username" :value="user?.username" hidden readonly />
					<div class="field">
						<label for="acct-current">Current password</label>
						<input id="acct-current" v-model="currentPassword" type="password" autocomplete="current-password" />
					</div>
					<div class="field">
						<label for="acct-new">New password</label>
						<input id="acct-new" v-model="newPassword" type="password" autocomplete="new-password" />
					</div>
					<div class="field">
						<label for="acct-confirm">Confirm new password</label>
						<input id="acct-confirm" v-model="confirmPassword" type="password" autocomplete="new-password" />
					</div>
					<p v-if="passwordMessage" :class="['alert', `alert-${passwordMessage.kind}`]" role="status">{{ passwordMessage.text }}</p>
					<div>
						<button class="btn btn-primary" type="submit" :disabled="passwordBusy || !currentPassword || !newPassword">
							{{ passwordBusy ? "Saving…" : "Change password" }}
						</button>
					</div>
				</form>
			</section>
		</div>

		<section class="card danger-zone" aria-labelledby="delete-heading">
			<div>
				<h2 id="delete-heading">Delete account</h2>
				<p class="muted">Permanently deletes your account, tracker history, and saved reports. This cannot be undone.</p>
			</div>
			<form class="form" novalidate @submit.prevent="removeAccount">
				<div class="field">
					<label for="acct-delete">Type <strong>{{ user?.username }}</strong> to confirm</label>
					<input id="acct-delete" v-model="deleteConfirm" type="text" autocomplete="off" />
				</div>
				<p v-if="deleteError" class="alert alert-error" role="alert">{{ deleteError }}</p>
				<div>
					<button class="btn btn-danger" type="submit" :disabled="deleteBusy || deleteConfirm !== user?.username">
						{{ deleteBusy ? "Deleting…" : "Delete my account" }}
					</button>
				</div>
			</form>
		</section>
	</div>
</template>

<style scoped>
.grid-2 {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
	gap: var(--space-5);
	align-items: start;
}

.danger-zone {
	border-color: #f0c9c4;
}
</style>
