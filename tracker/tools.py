"""Run a tracker tool without the model, exactly as the A1B handout writes it:

    python -m tracker.tools fetch_article <url>
    python -m tracker.tools search_web <query>
    python -m tracker.tools list_company_jobs <company_id>
    python -m tracker.tools finish --run RUN_ID --file draft.json

This wrapper only forwards its arguments to the Node tool CLI (backend/src/tracker/tools/cli.ts),
so it applies the same URL policy, DNS checks, timeouts, and size limits as the agent. It
contains no tool logic of its own. Run it from the repository root after `npm run setup`.
"""

import shutil
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"


def main() -> int:
    tsx = BACKEND / "node_modules" / ".bin" / ("tsx.cmd" if sys.platform == "win32" else "tsx")
    if not tsx.exists():
        print("backend dependencies are missing; run `npm run setup` first.", file=sys.stderr)
        return 2
    if shutil.which("node") is None:
        print("Node.js is not on PATH; install Node 22.13 or newer.", file=sys.stderr)
        return 2
    command = [str(tsx), str(BACKEND / "src" / "tracker" / "tools" / "cli.ts"), *sys.argv[1:]]
    return subprocess.call(command, cwd=BACKEND)


if __name__ == "__main__":
    sys.exit(main())
