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

# Which keys are set (values are never printed).
has_key() {
	grep -Eq "^[[:space:]]*$1[[:space:]]*=[[:space:]]*[^[:space:]]" "$ROOT/backend/.env" "$ROOT/backend/.env.local" 2>/dev/null
}
verifier_url() {
	grep -Eh "^[[:space:]]*VERIFIER_URL[[:space:]]*=" "$ROOT/backend/.env" 2>/dev/null | tail -1 | sed -E 's/^[^=]*=[[:space:]]*//; s/^["'\'']//; s/["'\'']$//'
}

LOCAL_VERIFIER=0
if has_key VERIFIER_GROQ_API_KEY && has_key VERIFIER_MODEL; then
	case "$(verifier_url)" in
		"" | *localhost* | *127.0.0.1*) LOCAL_VERIFIER=1 ;;
	esac
fi

echo "Starting backend (API + orchestrator)..."
if [[ "$LOCAL_VERIFIER" == "1" ]]; then
	open_terminal "Intersearch Backend" "$ROOT/backend" "VERIFIER_URL=http://127.0.0.1:4002 npm run dev"
else
	open_terminal "Intersearch Backend" "$ROOT/backend" "npm run dev"
fi

echo "Starting researcher..."
if has_key GROQ_API_KEY; then
	open_terminal "Intersearch Researcher" "$ROOT/backend" "npm run dev:researcher"
else
	echo "  ! GROQ_API_KEY is empty in backend/.env.local: the researcher will not start, and runs will show stale results."
fi

if [[ "$LOCAL_VERIFIER" == "1" ]]; then
	echo "Starting local verifier on :4002..."
	open_terminal "Intersearch Verifier" "$ROOT/backend" "npm run dev:verifier"
elif [[ -n "$(verifier_url)" ]]; then
	echo "Verifier: $(verifier_url) (Render; the dashboard's Wake verifier button wakes it)"
else
	echo "  ! No verifier: set VERIFIER_URL in backend/.env, or VERIFIER_GROQ_API_KEY and VERIFIER_MODEL in backend/.env.local for a local one."
fi
for key in RESEARCHER_TOKEN VERIFIER_TOKEN; do
	has_key "$key" || echo "  ! $key is missing: the dashboard cannot start runs until setup-env.mjs adds it."
done

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
