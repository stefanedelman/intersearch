import { onBeforeUnmount, onMounted } from "vue";

/**
 * Bounded polling: runs `tick` every `intervalMs` while `active()` is true, pauses while the tab is
 * hidden, backs off after errors (up to 60 s), and stops when the component unmounts.
 */
export function usePolling(tick: () => Promise<void>, active: () => boolean, intervalMs = 4000) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let delay = intervalMs;
	let stopped = false;

	const schedule = () => {
		clearTimeout(timer);
		if (stopped || !active()) return;
		timer = setTimeout(run, delay);
	};

	async function run() {
		if (stopped) return;
		if (document.hidden) {
			schedule();
			return;
		}
		try {
			await tick();
			delay = intervalMs;
		} catch {
			delay = Math.min(delay * 2, 60_000);
		}
		schedule();
	}

	const onVisibility = () => {
		if (!document.hidden) schedule();
	};

	onMounted(() => document.addEventListener("visibilitychange", onVisibility));
	onBeforeUnmount(() => {
		stopped = true;
		clearTimeout(timer);
		document.removeEventListener("visibilitychange", onVisibility);
	});

	return { restart: schedule };
}
