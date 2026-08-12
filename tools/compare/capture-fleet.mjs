// Render another extension's child-transcript pane under this extension's theme
// and dump the escapes, so the colours it picks up can be read back with
// tools/compare/decode.mjs.
//
//   node tools/compare/capture-fleet.mjs <out-prefix> [width]
//
// Writes <out>-collapsed.{ansi,txt} and <out>-expanded.{ansi,txt}.
//
// Why not capture.sh: that pane is a foreign overlay reached by a slash command,
// and it only lists runs whose recorded session id matches the live one — which
// is not knowable before launch. Its renderer is a pure function of
// (transcript, width, theme), so calling it directly is both deterministic and
// exactly what the real thing draws. What this does NOT cover is the overlay
// frame around it, which belongs to that extension's own component.
//
// The pane is rendered from whatever version is installed, not from a checkout,
// so this reports what the user actually sees. It resolves `@earendil-works/*`
// by staging a copy of that source next to this repo's node_modules — the
// installed package has none of its own, since pi supplies them at load time.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const THEME = path.join(REPO, "themes", "omp-dark-catppuccin.json");
const FOREIGN = path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents");

const [outPrefix, widthArg] = process.argv.slice(2);
if (!outPrefix) {
	console.error("usage: node tools/compare/capture-fleet.mjs <out-prefix> [width]");
	process.exit(64);
}
const WIDTH = Number(widthArg ?? 120);

if (!fs.existsSync(FOREIGN)) {
	console.error(`no installed child-transcript source at ${FOREIGN}`);
	process.exit(1);
}
const version = JSON.parse(fs.readFileSync(path.join(FOREIGN, "package.json"), "utf-8")).version;

// Stage the foreign source where this repo's node_modules is on its resolution
// path. Copying rather than symlinking the package: Node resolves a symlinked
// module to its real path and would walk up from there, finding nothing.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fleet-capture-"));
fs.cpSync(path.join(FOREIGN, "src"), path.join(stage, "src"), { recursive: true });
fs.symlinkSync(path.join(REPO, "node_modules"), path.join(stage, "node_modules"), "dir");

const pi = await import(path.join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"));
const themeModule = await import(
	path.join(REPO, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "interactive", "theme", "theme.js")
);

// initTheme(name) only finds themes pi itself registered at startup, and falls
// back to "dark" in silence when it does not — which would produce a capture of
// the wrong theme that still looks plausible. Load the file this repo ships.
//
// The second argument is the COLOUR mode, not light/dark. Left to detection it
// reads the capabilities of whatever is running this, so a capture taken from a
// pipe comes back in 256 colours and every hex in it is a near miss rather than
// a match. Pinned, so the numbers can be compared to the theme file directly.
const ompTheme = themeModule.loadThemeFromPath(THEME, "truecolor");
themeModule.setThemeInstance(ompTheme);

const { readFleetTranscript, renderFleetTranscript } = await import(path.join(stage, "src", "tui", "fleet-transcript.ts"));

// One run whose records reach every colour the pane uses: a bash tail long
// enough to be cut, a highlighted read, a failure, something still running, and
// both message kinds.
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fleet-fixture-"));
const transcriptPath = path.join(fixtureRoot, "transcript-0.jsonl");
const records = [
	{ recordType: "message", role: "user", text: "Check the build and report what broke.", ts: 1000 },
	{ recordType: "tool_start", toolCallId: "t1", toolName: "bash", argsPreview: "npm run build", argsPayload: JSON.stringify({ command: "npm run build" }), ts: 1100 },
	{ recordType: "tool_end", toolCallId: "t1", toolName: "bash", ts: 3400 },
	{
		recordType: "message", role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, ts: 3500,
		text: Array.from({ length: 11 }, (_, i) => `  building module ${i + 1} of 11`).join("\n"),
	},
	{ recordType: "tool_start", toolCallId: "t2", toolName: "read", argsPreview: "src/index.ts", argsPayload: JSON.stringify({ path: "src/index.ts" }), ts: 3600 },
	{ recordType: "tool_end", toolCallId: "t2", toolName: "read", ts: 3800 },
	{
		recordType: "message", role: "toolResult", toolCallId: "t2", toolName: "read", isError: false, ts: 3900,
		text: "export function widen(value: number): string {\n\treturn `${value}px`; // a comment\n}",
	},
	{ recordType: "tool_start", toolCallId: "t3", toolName: "write", argsPreview: "dist/out.js", argsPayload: JSON.stringify({ path: "dist/out.js", content: "x" }), ts: 4000 },
	{ recordType: "tool_end", toolCallId: "t3", toolName: "write", ts: 4100 },
	{ recordType: "message", role: "toolResult", toolCallId: "t3", toolName: "write", isError: true, text: "EACCES: permission denied, open 'dist/out.js'", ts: 4200 },
	{ recordType: "message", role: "assistant", text: "The build fails at **module 11**. Here is the offending call:\n\n```ts\nconst out = widen(12);\n```\n\nI will retry once permissions are fixed.", ts: 4300 },
	{ recordType: "tool_start", toolCallId: "t4", toolName: "grep", argsPreview: "EACCES", argsPayload: JSON.stringify({ pattern: "EACCES" }), ts: 4400 },
];
fs.writeFileSync(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf-8");

const transcript = readFleetTranscript(transcriptPath, { trustedRoots: [fixtureRoot] });
const markdownTheme = pi.getMarkdownTheme();

for (const [label, expandedTools] of [["collapsed", false], ["expanded", true]]) {
	const lines = renderFleetTranscript(transcript, WIDTH, ompTheme, markdownTheme, { expandedTools });
	fs.writeFileSync(`${outPrefix}-${label}.ansi`, `${lines.join("\n")}\n`, "utf-8");
	// biome-ignore lint: the point of the sibling file is to be greppable by line.
	fs.writeFileSync(`${outPrefix}-${label}.txt`, `${lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n")}\n`, "utf-8");
	console.log(`  ${label}: ${lines.length} rows -> ${outPrefix}-${label}.ansi`);
}

fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(fixtureRoot, { recursive: true, force: true });
console.log(`  rendered at width ${WIDTH} under ${path.basename(THEME)}, from installed source ${version}`);
