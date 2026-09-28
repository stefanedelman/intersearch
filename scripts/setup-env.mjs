// Creates backend/.env.local (ignored by git) with empty provider-key slots, only if it is missing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "backend", ".env.local");

if (fs.existsSync(target)) {
	console.log("backend/.env.local already exists; leaving it unchanged.");
} else {
	fs.writeFileSync(
		target,
		[
			"# Local secrets. Never commit this file.",
			"# Get a Groq key at https://console.groq.com/keys and a Tavily key at https://app.tavily.com",
			"GROQ_API_KEY=",
			"TAVILY_API_KEY=",
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	console.log("Created backend/.env.local. Add your GROQ_API_KEY and TAVILY_API_KEY there before running the tracker.");
}
