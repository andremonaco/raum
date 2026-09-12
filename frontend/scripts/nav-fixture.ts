/**
 * Reproducible, fully isolated navigation fixture — OpenSpec change
 * `instant-view-switching`, task 1.1 (see
 * `openspec/changes/instant-view-switching/implementation-guide.md` §1.1 and
 * design.md decision 8).
 *
 * Run manually via `bun run scripts/nav-fixture.ts` (or `task fixture:nav`).
 * Not in CI: it creates git repositories, a private raum config tree and a
 * private tmux server, and it is meant to be driven by hand against a
 * packaged release build.
 *
 * Isolation (verified against the sources, not assumed):
 *   - `RAUM_INSTANCE=<name>` → `raum_core::paths::instance_name()` returns
 *     `raum-<name>` (crates/raum-core/src/paths.rs:19-28), which is BOTH the
 *     config-root directory name (paths.rs:38-47) and the tmux socket name
 *     (crates/raum-tmux/src/manager.rs:31-37).
 *   - `XDG_CONFIG_HOME=<root>/config` → config root becomes
 *     `<root>/config/raum-<name>` instead of `~/.config/raum` (paths.rs:40-46).
 *   - `RAUM_TMUX_SOCKET=<socket>` is set explicitly as well; an explicit value
 *     wins over the instance-derived one (manager.rs:31-36), so the fixture can
 *     never land on the user's default `-L raum` server.
 * Nothing here writes to `~/.config/raum`, to the default tmux socket, or to a
 * harness config: only `kind = "shell"` panes are seeded, and harness config
 * injection runs on harness spawn only.
 *
 * Creation path: the fixture writes the instance's own `project.toml` files
 * (the exact registry `project_register` writes — src-tauri/src/commands/project.rs)
 * plus `state/active-layout.toml` whose tabs deliberately carry NO `session_id`
 * (optional field, crates/raum-core/src/config.rs:830-834). On launch the app
 * rehydrates that layout (frontend/src/app.tsx:hydrateActiveLayout) and each
 * session-less tab spawns through the normal `terminal_spawn` path
 * (frontend/src/components/terminal-pane.tsx). No tmux session is ever created
 * behind the app's back — that would exercise orphan recovery instead.
 *
 * Usage:
 *   bun run scripts/nav-fixture.ts --profile reference|stress [--root DIR]
 *        [--seed N] [--projects N] [--sessions N] [--rate-kib-s N]
 *        [--history-lines N]
 *   bun run scripts/nav-fixture.ts --producers <fixture-manifest.json>
 *   bun run scripts/nav-fixture.ts --cleanup   <fixture-manifest.json>
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const LAYOUT_UNIT = 10_000; // frontend/src/stores/runtimeLayoutStore.ts:58
const DEFAULT_SOCKET = "raum"; // crates/raum-tmux/src/manager.rs:20
const LINE_BYTES = 64; // producer.sh emits fixed 64-byte lines
/** Written into the fixture root, holds the instance name. `--cleanup`
 *  refuses any root that does not carry a marker matching the manifest. */
const MARKER = ".raum-nav-fixture";

interface Profile {
  projects: number;
  sessions: number;
  /** Worktree scopes per project = repo root + (scopes - 1) git worktrees. */
  scopes: number;
  historyLines: number;
  rateKiBs: number;
}

const PROFILES: Record<string, Profile> = {
  // design.md §8 "Reference": 10 projects, 3 worktree scopes each, 30 sessions.
  reference: { projects: 10, sessions: 30, scopes: 3, historyLines: 10_000, rateKiBs: 16 },
  // design.md §8 "Additional stress": 20 projects / 100 sessions.
  stress: { projects: 20, sessions: 100, scopes: 3, historyLines: 10_000, rateKiBs: 16 },
};

// ---- args -----------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function num(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

// ---- small helpers --------------------------------------------------------

function run(cmd: string, args: string[], cwd?: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr ?? ""}`);
  }
}

function capture(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "") : "";
}

function mkdir700(p: string): void {
  mkdirSync(p, { recursive: true, mode: 0o700 });
}

function writeExec(p: string, body: string): void {
  writeFileSync(p, body, { mode: 0o755 });
}

/** TOML string literal. Fixture paths are plain, but stay honest about it. */
function t(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Deterministic 32-bit LCG so a seed reproduces the same fixture. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** Integer boundary of slice `i` of `n` over `LAYOUT_UNIT` — exact, no seams. */
function bound(i: number, n: number): number {
  return Math.round((i * LAYOUT_UNIT) / n);
}

// ---- producers ------------------------------------------------------------

/** 54 chars, so `%08d ` + payload + newline is exactly 64 bytes. */
const PAYLOAD = "navfix-".repeat(8).slice(0, 54);

const PRODUCER_SH = `#!/bin/sh
# navfix producer — numbered lines on the normal buffer at a target byte rate.
#   usage: producer.sh [KIB_PER_S] [TOTAL_LINES]
#     KIB_PER_S    target kibibytes/second; 0 = unthrottled (history seeding)
#     TOTAL_LINES  stop after N lines; 0 = run until killed
# Lines are exactly 64 bytes. The ACHIEVED bytes/second is appended to
# ../logs/producer-<pid>.log — report that number, not the target.
set -u
rate_kib=\${1:-16}
total=\${2:-0}
payload="${PAYLOAD}"
log_dir="\${RAUM_FIXTURE_LOG_DIR:-$(cd "$(dirname "$0")/../logs" 2>/dev/null && pwd)}"
log="\${log_dir:-/tmp}/producer-$$.log"
if [ "$rate_kib" -eq 0 ]; then per_tick=2000; else per_tick=$(( rate_kib * 1024 / 640 )); fi
[ "$per_tick" -lt 1 ] && per_tick=1
n=0
start=$(date +%s)
report() {
  now=$(date +%s); el=$(( now - start )); [ "$el" -lt 1 ] && el=1
  printf "%s lines=%s bytes=%s elapsed_s=%s actual_bytes_per_s=%s target_kib_s=%s\\n" \\
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$n" "$(( n * 64 ))" "$el" "$(( n * 64 / el ))" "$rate_kib" >> "$log"
}
trap "report; exit 0" INT TERM
ticks=0
while [ "$total" -eq 0 ] || [ "$n" -lt "$total" ]; do
  i=0
  while [ "$i" -lt "$per_tick" ]; do
    n=$(( n + 1 )); i=$(( i + 1 ))
    printf "%08d %s\\n" "$n" "$payload"
    if [ "$total" -ne 0 ] && [ "$n" -ge "$total" ]; then break; fi
  done
  ticks=$(( ticks + 1 ))
  [ $(( ticks % 100 )) -eq 0 ] && report
  [ "$rate_kib" -gt 0 ] && sleep 0.1
done
report
`;

const PRODUCER_ALT_SH = `#!/bin/sh
# navfix alternate-screen producer — periodic FULL redraw, like a harness TUI.
#   usage: producer-alt.sh [REDRAWS_PER_S] [ROWS]
set -u
hz=\${1:-4}
rows=\${2:-40}
payload="${PAYLOAD}"
printf "\\033[?1049h"
cleanup() { printf "\\033[?1049l"; exit 0; }
trap cleanup INT TERM
frame=0
while :; do
  frame=$(( frame + 1 ))
  printf "\\033[H\\033[2J"
  r=1
  while [ "$r" -le "$rows" ]; do
    printf "\\033[1;36mframe %06d\\033[0m row %03d %s\\n" "$frame" "$r" "$payload"
    r=$(( r + 1 ))
  done
  sleep "$(awk -v h="$hz" 'BEGIN{ printf "%.3f", 1/h }')"
done
`;

const PROBE_SH = `#!/bin/sh
# navfix echo probe — the ONLY session that may receive test keystrokes.
# Type a line + Enter; it comes back prefixed, so input latency can be timed
# against a visible response. Never point this at a harness pane.
printf "navfix echo probe ready (Ctrl-D to exit)\\n"
while IFS= read -r line; do printf "echo %s\\n" "$line"; done
`;

// ---- create ---------------------------------------------------------------

interface Manifest {
  version: number;
  createdAt: string;
  profile: string;
  seed: number;
  root: string;
  instance: string;
  configHome: string;
  configRoot: string;
  socket: string;
  env: Record<string, string>;
  counts: {
    projects: number;
    worktreeScopesPerProject: number;
    sessions: number;
    cells: number;
    visiblePanesInActiveProject: number;
  };
  requested: { rateKiBs: number; historyLines: number; lineBytes: number };
  projects: Array<{ slug: string; name: string; root: string; worktrees: string[] }>;
  paths: Record<string, string>;
  /** The only paths `--cleanup` may delete. Each must resolve inside `root`. */
  cleanupPaths: string[];
  launch: Record<string, string>;
}

function create(args: Record<string, string>): void {
  const profileName = args.profile ?? "reference";
  const profile = PROFILES[profileName];
  if (!profile) throw new Error(`unknown --profile ${profileName} (reference|stress)`);

  const seed = num(args.seed, 1337);
  const projects = num(args.projects, profile.projects);
  const sessions = num(args.sessions, profile.sessions);
  const scopes = Math.max(1, num(args.scopes, profile.scopes));
  const rateKiBs = num(args["rate-kib-s"], profile.rateKiBs);
  const historyLines = num(args["history-lines"], profile.historyLines);
  if (projects < 1 || sessions < projects) {
    throw new Error("need at least 1 project and at least one session per project");
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const instance = `navfix-${stamp}`;
  const socket = `raum-${instance}`;
  const root = resolve(args.root ?? join(tmpdir(), `raum-nav-fixture-${stamp}`));
  if (root.split("/").filter(Boolean).length < 2) throw new Error(`refusing root ${root}`);

  const configHome = join(root, "config");
  const configRoot = join(configHome, socket);
  const reposDir = join(root, "repos");
  const binDir = join(root, "bin");
  const logsDir = join(root, "logs");
  for (const d of [
    reposDir,
    binDir,
    logsDir,
    join(configRoot, "projects"),
    join(configRoot, "state"),
  ]) {
    mkdir700(d);
  }
  writeFileSync(join(root, MARKER), `${instance}\n`);
  // `onboarded = true` skips the wizard; every other key defaults
  // (crates/raum-core/src/config.rs:33-56 is `#[serde(default)]`).
  writeFileSync(join(configRoot, "config.toml"), 'onboarded = true\nmultiplexer = "tmux"\n');
  writeFileSync(join(configRoot, "keybindings.toml"), "");

  writeExec(join(binDir, "producer.sh"), PRODUCER_SH);
  writeExec(join(binDir, "producer-alt.sh"), PRODUCER_ALT_SH);
  writeExec(join(binDir, "probe.sh"), PROBE_SH);

  // --- repositories + worktrees (the app discovers worktrees via
  //     `git worktree list` — src-tauri/src/commands/worktree/preview.rs:118) ---
  const rand = rng(seed);
  const manifestProjects: Manifest["projects"] = [];
  for (let p = 0; p < projects; p += 1) {
    const slug = `navfix-${String(p + 1).padStart(2, "0")}`;
    const repo = join(reposDir, slug);
    mkdirSync(repo, { recursive: true });
    run("git", ["init", "-q", "-b", "main"], repo);
    writeFileSync(
      join(repo, "README.md"),
      `# ${slug}\n\nDisposable raum navigation fixture (seed ${seed}, draw ${rand().toFixed(6)}).\n`,
    );
    run("git", ["add", "-A"], repo);
    run(
      "git",
      [
        "-c",
        "user.name=raum navfix",
        "-c",
        "user.email=navfix@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      repo,
    );
    const worktrees: string[] = [];
    for (let w = 1; w < scopes; w += 1) {
      // Matches the project default `pathPattern` (nested):
      // `{repo-root}/.raum/{branch-slug}` (crates/raum-core/src/config.rs:15).
      const branch = `navfix-scope-${w}`;
      const path = join(repo, ".raum", branch);
      run("git", ["worktree", "add", "-q", "-b", branch, path, "main"], repo);
      worktrees.push(path);
    }
    // The exact shape `project_register` writes (docs/config.md §project.toml).
    mkdir700(join(configRoot, "projects", slug));
    writeFileSync(
      join(configRoot, "projects", slug, "project.toml"),
      [
        `slug = ${t(slug)}`,
        `name = ${t(slug)}`,
        `root_path = ${t(repo)}`,
        `color = "#7dd3fc"`,
        `in_repo_settings = false`,
        ``,
        `[hydration]`,
        `copy = []`,
        `symlink = []`,
        ``,
        `[worktree]`,
        `pathStrategy = "nested"`,
        `pathPattern = "{repo-root}/.raum/{branch-slug}"`,
        `branchPrefixMode = "none"`,
        ``,
        `[agent_defaults]`,
        ``,
      ].join("\n"),
      { mode: 0o600 },
    );
    manifestProjects.push({ slug, name: slug, root: repo, worktrees });
  }

  // --- layout: one column per project, one cell per worktree scope ----------
  const perProject = Math.floor(sessions / projects);
  let remainder = sessions - perProject * projects;
  const lines: string[] = [
    `saved_at = ${Math.floor(Date.now() / 1000)}`,
    `project_slug = ${t(manifestProjects[0].slug)}`,
    `focused_pane_id = ${t(`${manifestProjects[0].slug}-c1`)}`,
    ``,
  ];
  let cellCount = 0;
  manifestProjects.forEach((proj, p) => {
    const mine = perProject + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    const cells = Math.min(scopes, mine);
    const scopePaths = [proj.root, ...proj.worktrees];
    for (let c = 0; c < cells; c += 1) {
      cellCount += 1;
      const cellId = `${proj.slug}-c${c + 1}`;
      const wt = scopePaths[c % scopePaths.length];
      const x = bound(p, projects);
      const y = bound(c, cells);
      // Round-robin the surplus tabs over this project's cells.
      const tabs = Math.floor(mine / cells) + (c < mine % cells ? 1 : 0);
      lines.push(
        `[[cells]]`,
        `id = ${t(cellId)}`,
        `x = ${x}`,
        `y = ${y}`,
        `w = ${bound(p + 1, projects) - x}`,
        `h = ${bound(c + 1, cells) - y}`,
        `kind = "shell"`,
        `project_slug = ${t(proj.slug)}`,
        `worktree_id = ${t(wt)}`,
        `active_tab_id = ${t(`${cellId}-t1`)}`,
        ``,
      );
      for (let tb = 0; tb < tabs; tb += 1) {
        // No `session_id`: the app spawns each tab through `terminal_spawn`.
        lines.push(
          `[[cells.tabs]]`,
          `id = ${t(`${cellId}-t${tb + 1}`)}`,
          `project_slug = ${t(proj.slug)}`,
          `worktree_id = ${t(wt)}`,
          ``,
        );
      }
    }
  });
  const activeLayout = join(configRoot, "state", "active-layout.toml");
  writeFileSync(activeLayout, lines.join("\n"), { mode: 0o600 });

  const env: Record<string, string> = {
    RAUM_INSTANCE: instance,
    XDG_CONFIG_HOME: configHome,
    RAUM_TMUX_SOCKET: socket,
  };
  const envInline = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const manifest: Manifest = {
    version: 2,
    createdAt: new Date().toISOString(),
    profile: profileName,
    seed,
    root,
    instance,
    configHome,
    configRoot,
    socket,
    env,
    counts: {
      projects,
      worktreeScopesPerProject: scopes,
      sessions,
      cells: cellCount,
      // No `worktree_scopes` is written, so each project opens in the
      // cross-worktree "all" view: every cell of the active project is visible.
      visiblePanesInActiveProject: Math.min(scopes, Math.ceil(sessions / projects)),
    },
    requested: { rateKiBs, historyLines, lineBytes: LINE_BYTES },
    projects: manifestProjects,
    paths: {
      producer: join(binDir, "producer.sh"),
      producerAlt: join(binDir, "producer-alt.sh"),
      probe: join(binDir, "probe.sh"),
      activeLayout,
      logs: logsDir,
      marker: join(root, MARKER),
    },
    cleanupPaths: [configHome, reposDir, binDir, logsDir, join(root, MARKER)],
    launch: {
      // `open --env VAR=value` passes env to the launched app (macOS `open(1)`).
      releaseApp: `${envInline} /Applications/raum.app/Contents/MacOS/raum`,
      releaseAppViaOpen: `open -n -a raum ${Object.entries(env)
        .map(([k, v]) => `--env ${k}=${v}`)
        .join(" ")}`,
      // NOT `task dev`: its `env:` block pins RAUM_INSTANCE=dev (Taskfile.yml:18).
      dev: `cd src-tauri && ${envInline} cargo tauri dev --config tauri.dev.conf.json`,
    },
  };
  const manifestPath = join(root, "fixture-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const perTick = Math.max(1, Math.floor((rateKiBs * 1024) / 640));
  console.log(`
navfix fixture created — profile ${profileName}, seed ${seed}

  root          ${root}
  instance      ${instance}
  config root   ${configRoot}
  tmux socket   ${socket}        (never the default "${DEFAULT_SOCKET}")
  manifest      ${manifestPath}

  ${projects} projects x ${scopes} worktree scopes, ${sessions} planned sessions in ${cellCount} cells.
  Producer target ${rateKiBs} KiB/s -> ${perTick * LINE_BYTES * 10} bytes/s actual (64-byte lines);
  the achieved rate is logged per producer under ${logsDir}.

Launch the PACKAGED RELEASE app against it (release build only — mocked/dev
builds do not validate native paint latency):

  ${manifest.launch.releaseApp}

  (or: ${manifest.launch.releaseAppViaOpen})

Dev build, if a controlled comparison is needed:

  ${manifest.launch.dev}

Then, inside that window only:
  1. Sessions spawn themselves from the rehydrated layout — wait until every
     pane is attached before measuring.
  2. Seed history:      ${manifest.paths.producer} 0 ${historyLines}
  3. Steady output:     ${manifest.paths.producer} ${rateKiBs} 0
     Alternate screen:  ${manifest.paths.producerAlt} 4 40
     Input probe:       ${manifest.paths.probe}
     (or drive every shell at once: bun run scripts/nav-fixture.ts --producers ${manifestPath})

Cleanup (removes ONLY this fixture's root and its own tmux server):

  bun run scripts/nav-fixture.ts --cleanup ${manifestPath}
`);
}

// ---- producers / cleanup --------------------------------------------------

function loadManifest(path: string): Manifest {
  const m = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  if (!m.socket || m.socket === DEFAULT_SOCKET) {
    throw new Error(
      `refusing to act on manifest socket "${m.socket}" — that is the default raum server`,
    );
  }
  const root = m.root ? resolve(m.root) : "";
  if (!root || root.split("/").filter(Boolean).length < 2) {
    throw new Error(`refusing to act on manifest root "${m.root}"`);
  }
  const home = resolve(homedir());
  const config = join(home, ".config");
  if (root === home || home.startsWith(`${root}/`)) {
    throw new Error(`refusing to act on manifest root "${root}" — it is $HOME or a parent of it`);
  }
  if (root === config || root.startsWith(`${config}/`)) {
    throw new Error(`refusing to act on manifest root "${root}" — it is inside ~/.config`);
  }
  // A hand-edited manifest cannot point cleanup at a directory this script did
  // not create: the marker must exist AND name the same instance.
  const marker = join(root, MARKER);
  const stamp = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
  if (stamp !== m.instance || !m.instance) {
    throw new Error(
      `refusing to act on "${root}" — ${stamp ? `marker says "${stamp}"` : `no ${MARKER} marker`}, ` +
        `manifest instance is "${m.instance}"`,
    );
  }
  return m;
}

function fixtureSessions(socket: string): string[] {
  return capture("tmux", ["-L", socket, "list-sessions", "-F", "#{session_name}"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Start a producer in every fixture SHELL session. Shells only — session ids
 *  are `raum-sh-…` (src-tauri/src/commands/terminal/helpers.rs:102-109), so a
 *  harness pane can never receive these keystrokes. */
function producers(manifestPath: string, args: Record<string, string>): void {
  const m = loadManifest(manifestPath);
  const rate = num(args["rate-kib-s"], m.requested.rateKiBs);
  const history = num(args["history-lines"], m.requested.historyLines);
  const shells = fixtureSessions(m.socket).filter((s) => s.startsWith("raum-sh-"));
  if (shells.length === 0) {
    console.log(`no shell sessions on socket ${m.socket} — launch the app first`);
    return;
  }
  const cmd = `${m.paths.producer} 0 ${history} && ${m.paths.producer} ${rate} 0`;
  for (const s of shells) {
    run("tmux", ["-L", m.socket, "send-keys", "-t", s, cmd, "Enter"]);
  }
  console.log(
    `started history seed (${history} lines) + ${rate} KiB/s producer in ${shells.length} shell sessions on ${m.socket}`,
  );
}

function cleanup(manifestPath: string): void {
  const m = loadManifest(manifestPath);
  const shells = fixtureSessions(m.socket);
  if (shells.length > 0) {
    console.log(`killing ${shells.length} sessions on socket ${m.socket}: ${shells.join(", ")}`);
    spawnSync("tmux", ["-L", m.socket, "kill-server"], { stdio: "ignore" });
  }
  const root = resolve(m.root);
  const allowed = new Set(
    (m.projects ?? []).flatMap((p) => [resolve(p.root), ...p.worktrees.map((w) => resolve(w))]),
  );
  for (const raw of m.cleanupPaths ?? []) {
    const target = resolve(raw);
    if (!target.startsWith(`${root}/`) && !allowed.has(target)) {
      console.warn(`skipping ${target} — outside the fixture root and not a listed worktree`);
      continue;
    }
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
    console.log(`removed ${target}`);
  }
  if (existsSync(manifestPath)) rmSync(manifestPath, { force: true });
  // Only succeeds when nothing else was left in the root — anything a developer
  // dropped in there stays put.
  try {
    rmdirSync(root);
    console.log(`removed ${root}`);
  } catch {
    console.log(`kept ${root} — not empty after removing the fixture's own paths`);
  }
  console.log(
    `fixture ${m.instance} cleaned up. The default "${DEFAULT_SOCKET}" socket was never touched.`,
  );
}

// ---- main -----------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
try {
  if (args.cleanup && args.cleanup !== "true") cleanup(args.cleanup);
  else if (args.producers && args.producers !== "true") producers(args.producers, args);
  else create(args);
} catch (err) {
  console.error(`nav-fixture: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
