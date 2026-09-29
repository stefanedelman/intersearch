#!/usr/bin/env bash

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_URL="http://localhost:5173"

open_terminal() {
	local title="$1"
	local directory="$2"
	local command="$3"

	if [[ "$(uname -s)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1; then
		osascript - "$title" "$directory" "$command" <<'APPLESCRIPT'
on run argv
	set windowTitle to item 1 of argv
	set workingDirectory to item 2 of argv
	set shellCommand to item 3 of argv
	tell application "Terminal"
		activate
		do script "printf '\\033]0;" & windowTitle & "\\007'; cd " & quoted form of workingDirectory & " && " & shellCommand
	end tell
end run
APPLESCRIPT
	else
		(cd "$directory" && nohup bash -lc "$command" >"${TMPDIR:-/tmp}/${title// /-}.log" 2>&1 &)
	fi
}

echo "Installing backend dependencies..."
if ! (cd "$ROOT/backend" && npm i && npm run prisma:generate); then
	echo "Backend setup failed." >&2
	exit 1
fi

echo "Installing frontend dependencies..."
if ! (cd "$ROOT/frontend" && npm i); then
	echo "Frontend npm install failed." >&2
	exit 1
fi

node "$ROOT/scripts/setup-env.mjs"

echo "Starting backend..."
open_terminal "Intersearch Backend" "$ROOT/backend" "npm run dev"

echo "Starting frontend..."
open_terminal "Intersearch Frontend" "$ROOT/frontend" "npm run dev -- --host 127.0.0.1"

sleep 3

echo "Opening Codex..."
if command -v codex >/dev/null 2>&1; then
	open_terminal "Codex" "$ROOT" "codex"
fi

echo "Opening Claude..."
if command -v claude >/dev/null 2>&1; then
	open_terminal "Claude" "$ROOT" "claude"
fi

echo "Opening browser..."
if [[ "$(uname -s)" == "Darwin" ]]; then
	if [[ -d "/Applications/Google Chrome.app" ]]; then
		open -a "Google Chrome" "$FRONTEND_URL"
	else
		open "$FRONTEND_URL"
	fi
elif command -v xdg-open >/dev/null 2>&1; then
	xdg-open "$FRONTEND_URL" >/dev/null 2>&1 &
fi

echo "Done. App URL: $FRONTEND_URL"
