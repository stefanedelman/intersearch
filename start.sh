#!/usr/bin/env bash
# Starts the Intersearch backend (http://localhost:3000) and frontend (http://localhost:5173).
# Press Ctrl-C to stop both. First time on a new machine? Run `npm run setup` first.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d backend/node_modules ] || [ ! -d frontend/node_modules ]; then
	echo "Dependencies are missing. Run: npm run setup"
	exit 1
fi

for port in 3000 5173; do
	if lsof -ti "tcp:$port" >/dev/null 2>&1; then
		echo "Port $port is already in use. Stop whatever is running there, then try again."
		exit 1
	fi
done

# Job control gives each server its own process group, so stopping a group also stops the
# node processes that npm starts underneath it.
set -m
pids=()
cleanup() {
	trap - INT TERM EXIT
	echo
	echo "Stopping..."
	for pid in "${pids[@]}"; do
		kill -TERM -- "-$pid" 2>/dev/null || true
	done
	wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

npm run dev:backend &
pids+=($!)
npm run dev:frontend &
pids+=($!)

echo
echo "Backend:  http://localhost:3000"
echo "Frontend: http://localhost:5173  (log in as NYUgrader / Courant2026!)"
echo "Press Ctrl-C to stop both."
echo

wait
