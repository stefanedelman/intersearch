import { createRouter, createWebHistory } from "vue-router";
import { onSessionEnded, useAuth } from "../composables/useAuth";

const router = createRouter({
	history: createWebHistory(),
	routes: [
		{ path: "/", name: "dashboard", component: () => import("../views/DashboardView.vue"), meta: { requiresAuth: true } },
		{ path: "/runs", name: "runs", component: () => import("../views/RunHistoryView.vue"), meta: { requiresAuth: true } },
		{ path: "/runs/:id", name: "run", component: () => import("../views/RunDetailView.vue"), meta: { requiresAuth: true } },
		{ path: "/account", name: "account", component: () => import("../views/AccountView.vue"), meta: { requiresAuth: true } },
		{ path: "/login", name: "login", component: () => import("../views/LoginView.vue"), meta: { guestOnly: true } },
		{ path: "/register", name: "register", component: () => import("../views/RegisterView.vue"), meta: { guestOnly: true } },
		{ path: "/:pathMatch(.*)*", redirect: "/" },
	],
	scrollBehavior: () => ({ top: 0 }),
});

// UX only: the API enforces authorization on every request regardless of these guards.
router.beforeEach((to) => {
	const { isSignedIn } = useAuth();
	if (to.meta.requiresAuth && !isSignedIn.value) {
		return { name: "login", query: to.fullPath !== "/" ? { redirect: to.fullPath } : {} };
	}
	if (to.meta.guestOnly && isSignedIn.value) return { name: "dashboard" };
	return true;
});

onSessionEnded(() => {
	const current = router.currentRoute.value;
	if (current.meta.requiresAuth) {
		void router.replace({ name: "login", query: { redirect: current.fullPath, expired: "1" } });
	}
});

export default router;
