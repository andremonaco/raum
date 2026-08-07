//! raum Tauri host. Entry point wires plugins and exposes the command surface.

mod cli;
mod cli_worktree;
mod commands;
mod keymap;
mod notifications;
mod path_env;
mod state;

use raum_core::logging;
use raum_core::paths;
use raum_core::store::ConfigStore;
use raum_hooks::{set_event_sock_env, spawn_event_socket};
use tauri::menu::Menu;
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadataBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager, Runtime};
#[cfg(target_os = "macos")]
use tauri_plugin_decorum::WebviewWindowExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tracing::{debug, info, warn};

/// ID of the "Settings…" item in the macOS app submenu. Clicking it emits
/// `menu-action` with this string as the payload so the frontend can route
/// the event to the same handler as the in-app settings gear.
#[cfg(target_os = "macos")]
const MENU_ID_OPEN_SETTINGS: &str = "open-settings";

/// ID of the "Install 'raum' Terminal Command" item in the macOS app submenu.
/// Clicking it emits `menu-action` with this payload; the frontend routes it to
/// the `cli_install_shim` command so users who drag the `.app` out of the DMG
/// get the `raum <dir>` terminal command (Homebrew users get it via the cask).
/// raum also attempts this automatically on first launch (see
/// [`cli::auto_install_shim_if_safe`]); this item is the manual fallback/repair.
#[cfg(target_os = "macos")]
const MENU_ID_INSTALL_CLI: &str = "install-cli";

/// ID of the "Check for Updates…" item in the macOS app submenu. Clicking it
/// emits `menu-action` with this payload; the frontend routes it to a silent
/// updater check that surfaces an in-app toast (`updateNotifier`).
#[cfg(target_os = "macos")]
const MENU_ID_CHECK_UPDATES: &str = "check-updates";

/// Bump `RLIMIT_NOFILE` to the hard cap on macOS.
///
/// GUI apps launched by Finder/Dock inherit launchd's soft limit (256 by
/// default). raum holds ~10–20 fds per terminal between PTY masters, tmux
/// client pipes, hook IPC sockets, and per-project file watchers, so 12
/// terminals saturates the cap and `tmux new-session` returns
/// `EMFILE` ("Too many open files"). The hard cap is `kern.maxfilesperproc`,
/// usually 24 576, which gives plenty of headroom for any sane number of
/// terminals.
///
/// Linux distros leave the soft limit at the per-user value (1024+) and the
/// system bus does not need help here, so the bump is macOS-only.
#[cfg(target_os = "macos")]
fn raise_nofile_limit() {
    use libc::{RLIMIT_NOFILE, getrlimit, rlimit, setrlimit};
    let mut lim = rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `getrlimit`/`setrlimit` are documented to take a pointer to a
    // valid `rlimit` and write/read it; we own `lim` for the call.
    #[allow(unsafe_code)]
    unsafe {
        if getrlimit(RLIMIT_NOFILE, &raw mut lim) != 0 {
            warn!("raise_nofile_limit: getrlimit failed");
            return;
        }
        let prev_soft = lim.rlim_cur;
        if lim.rlim_cur >= lim.rlim_max {
            info!(
                soft = prev_soft,
                hard = lim.rlim_max,
                "RLIMIT_NOFILE already at hard cap"
            );
            return;
        }
        lim.rlim_cur = lim.rlim_max;
        if setrlimit(RLIMIT_NOFILE, &raw const lim) != 0 {
            warn!(
                requested = lim.rlim_max,
                prev_soft = prev_soft,
                "raise_nofile_limit: setrlimit failed"
            );
        } else {
            info!(
                prev_soft = prev_soft,
                new_soft = lim.rlim_cur,
                "raised RLIMIT_NOFILE"
            );
        }
    }
}

pub fn run() {
    // Headless subcommands (`raum worktree …`) run to completion and exit here,
    // before any GUI/tracing/window setup.
    cli::dispatch_subcommand();

    // §2.7 — `--help` / `--version` print GUI-only help and exit before window.
    if !cli::handle_args() {
        return;
    }

    let _log_guard = logging::init_tracing(&paths::logs_dir());
    info!("raum starting");

    // Lift the launchd-imposed 256-fd ceiling before anything opens
    // descriptors (tmux, file watchers, hook sockets). Must happen after
    // tracing init so the bump is visible in the log.
    #[cfg(target_os = "macos")]
    raise_nofile_limit();

    // Bundled apps launched from Finder inherit a minimal PATH that doesn't
    // see Homebrew, nvm, or other dev tool locations — so harness binaries
    // (`claude`, `codex`, `opencode`) fail to resolve. Probe the user's
    // login shell once here, before any `which::which()` call runs.
    path_env::augment_process_path();

    // Install the uniform `raum` Agent Skill into each set-up harness so agents
    // running inside raum discover the `raum worktree create` CLI. Idempotent
    // (only rewrites on content change) and gated on each harness's config dir
    // existing, so it never litters. Detached so disk I/O can't delay the window.
    std::thread::spawn(|| {
        for w in raum_core::harness::install_raum_skill() {
            if w.wrote {
                info!(path = %w.path.display(), "installed raum skill");
            }
        }
    });

    // Capture an optional `raum <dir>` argument for a *cold* launch and seed it
    // into shared state; the frontend drains it on boot via
    // `cli_take_pending_open`. The already-running case is handled separately by
    // the single-instance callback below (it emits `cli-open-project`).
    let app_state = state::AppHandleState::default();
    if let Some(path) = std::env::current_dir()
        .ok()
        .and_then(|cwd| cli::parse_open_path(std::env::args().skip(1), &cwd))
    {
        if let Ok(mut guard) = app_state.pending_cli_open.lock() {
            *guard = Some(path);
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_decorum::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // §2.5 — duplicate launch focuses the existing window instead of
            // opening a new one. The callback fires on the already-running
            // instance; the duplicate process exits with status 0 after.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                if let Err(e) = win.set_focus() {
                    warn!(error = %e, "single-instance: set_focus failed");
                }
            } else {
                warn!("single-instance: main window not found");
            }
            // `raum <dir>` from a second invocation: resolve the directory
            // against the *second* process's CWD and hand the absolute path to
            // the frontend, which focuses an existing project or starts the add
            // flow for a new one.
            if let Some(path) =
                cli::parse_open_path(argv.iter().skip(1), std::path::Path::new(&cwd))
            {
                if let Err(e) = app.emit("cli-open-project", path.to_string_lossy().into_owned()) {
                    warn!(error = %e, "single-instance: cli-open-project emit failed");
                }
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Persist window position / size / maximized state across launches.
        // Without this the webview opens at tauri.conf.json's default 1440×900
        // every time, which forces users with bigger monitors to maximize on
        // every launch — and any harness pane spawned during the early-mount
        // window picks up the small intermediate size, leaving narrow content
        // permanently in xterm scrollback (xterm cannot reflow Ink-style
        // hard-wrapped lines once written).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .menu(build_app_menu)
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if let Err(e) = app.emit("menu-action", id) {
                warn!(menu_id = %id, error = %e, "menu-action emit failed");
            }
        })
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            // Terminal-launch bridge (`raum <dir>`): cold-start drain + the
            // "Install 'raum' Command in PATH" action.
            commands::cli::cli_take_pending_open,
            commands::cli::cli_install_shim,
            commands::config_get,
            commands::config_mark_onboarded,
            commands::active_layout_get,
            commands::active_layout_save,
            // App-lifecycle: quit-flush ack (Contract 1) + rehydrate-ready
            // poll (Contract 2).
            commands::lifecycle::app_quit_flush_done,
            commands::lifecycle::terminal_rehydrate_ready,
            commands::os_info,
            commands::keymap_get_defaults,
            commands::keymap_get_effective,
            commands::keymap_set_override,
            commands::keymap_clear_override,
            commands::prereqs_check,
            commands::harnesses_check,
            commands::server_restart::server_restart_status,
            commands::server_restart::server_restart_dismiss,
            commands::server_restart::server_restart_now,
            commands::tmux_health::tmux_version_status,
            commands::tmux_health::tmux_version_dismiss,
            commands::terminal::terminal_spawn,
            commands::terminal::terminal_reattach,
            commands::terminal::terminal_provider_replace,
            commands::terminal::terminal_provider_replay,
            commands::terminal::terminal_self_heal,
            commands::terminal::terminal_respawn_dead,
            commands::terminal::terminal_kill,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_list,
            commands::terminal::terminal_send_keys,
            commands::terminal::terminal_paste_paths,
            commands::terminal::terminal_paste_text,
            commands::terminal::terminal_pane_context,
            commands::terminal::terminal_pane_context_batch,
            commands::terminal::terminal_reap_stale,
            commands::terminal::terminal_kill_orphans,
            commands::terminal::terminal_reconcile,
            commands::terminal::terminal_snapshot_persist,
            commands::terminal::terminal_snapshot_load,
            commands::terminal::terminal_snapshot_delete,
            // Cross-harness review feature.
            commands::review::prepare_review,
            commands::review::record_review_link,
            commands::review::clear_review_link,
            commands::review::session_first_prompt,
            commands::agent::agent_list,
            commands::agent::agent_spawn,
            commands::agent::agent_state,
            // Record that the user saw a completion (rail dismiss) so it
            // stays quiet across a webview reload / app restart.
            commands::agent::agent_ack_state,
            // Cross-review picker: enumerate models per harness kind so the
            // overlay can present a real choice instead of a hardcoded list.
            commands::agent::list_harness_models,
            commands::agent::list_harness_models_refresh,
            // Atomic agents + terminals snapshot used by the top-row on
            // mount / cmd+r to seed both stores before any memo runs.
            commands::agent::agent_snapshot,
            // Hook-pipeline diagnostic (Harness Health panel): returns
            // "is the socket bound?" + "when did a hook last arrive?".
            commands::agent::hooks_diagnostics,
            // Synthetic round-trip probe for the UDS pipeline.
            commands::agent::hooks_selftest,
            // Phase 6 — on-demand per-harness selftest (Harness Health panel).
            commands::agent::harness_selftest,
            // Phase 7 — pure-read scan + on-demand install (Harness Health panel).
            commands::harness::harness_scan_install_state,
            commands::harness::harness_install,
            // §7.6 — Phase 2: reply to a parked PermissionRequest hook.
            commands::permission::reply_permission,
            // §5.4 — project command surface (Wave 3B).
            commands::project::project_register,
            commands::project::project_find_by_path,
            commands::project::project_list,
            commands::project::project_update,
            commands::project::project_remove,
            commands::project::project_config_effective,
            commands::project::project_list_gitignored,
            commands::project::project_list_dir,
            // §6.5–§6.8 — worktree command surface.
            commands::worktree_preview_path,
            commands::worktree_preview_manifest,
            commands::worktree_create,
            commands::worktree_list,
            commands::worktree_list_all,
            commands::worktree_branches,
            commands::worktree_branch_merged,
            commands::git_checkout_branch,
            commands::worktree_remove,
            commands::worktree_merge_preview,
            commands::worktree_merge,
            commands::worktree_config_write,
            // §9 — sidebar surface (Wave 3C).
            commands::worktree_status,
            commands::worktree_status_batch,
            commands::worktree_status_subscribe,
            commands::worktree_status_refresh,
            commands::git_log,
            commands::git_commit_files,
            commands::git_diff_commit,
            commands::worktree_list_dir,
            commands::git_stage,
            commands::git_unstage,
            commands::git_diff,
            commands::git_discard,
            commands::git_discard_all,
            commands::quickfire_history_get,
            commands::quickfire_history_push,
            commands::config_set_sidebar_width,
            // §11 — notifications surface (Wave 3E).
            commands::notifications::set_dock_badge,
            commands::notifications::notifications_focus_main,
            commands::notifications::notifications_mark_hint_shown,
            commands::notifications::config_set_notifications,
            commands::notifications::notifications_list_system_sounds,
            commands::notifications::notifications_play_sound,
            commands::notifications::notifications_check_authorization,
            commands::notifications::notifications_open_system_settings,
            notifications::send::notifications_send,
            notifications::clear::notifications_clear,
            commands::config_set_harness_flags,
            commands::config_set_claude_fullscreen,
            commands::config_set_worktree_path_pattern,
            commands::config_set_appearance_theme,
            commands::config_set_appearance_show_prompt_overlay,
            commands::config_set_projects_auto_hide,
            commands::config_set_terminals_auto_dock,
            // Global search — file search over a project's root or arbitrary path.
            commands::search::project_find_files,
            commands::search::search_files_in_path,
            commands::search::terminal_capture_text,
            // File editor — read/write files on behalf of the frontend.
            commands::files::file_read,
            commands::files::file_write,
            // Updater — persists the "check on launch" pref; actual
            // check/install happen via tauri-plugin-updater directly.
            commands::updater::config_set_updater_check_on_launch,
            // Reports how this binary was installed so the UI can disable
            // in-app install on distro-managed Linux `.deb` and fall back
            // to a "download from GitHub" link.
            commands::updater::updater_install_flavor,
            // Devtools — opened via keyboard shortcut since the native
            // right-click "Inspect" entry is globally suppressed.
            commands::devtools::open_devtools,
            // Focus-gated webview liveness check — recovers from macOS
            // killing the WKWebView WebContent process during screen lock
            // (black, dead window until app restart otherwise).
            commands::webview_health::webview_ready,
            commands::webview_health::webview_pong,
            commands::webview_health::webview_wake_report,
        ])
        .setup(|app| {
            let main_window = app.get_webview_window("main").unwrap();

            // macOS: equivalent of Electron's titleBarStyle:"hiddenInset".
            // We call set_title_bar_style directly — do NOT call
            // create_overlay_titlebar() which injects a JS drag-overlay div
            // that sits over the header and swallows all pointer events.
            #[cfg(target_os = "macos")]
            {
                use objc2::msg_send;
                use objc2::runtime::AnyObject;

                main_window
                    .set_title_bar_style(tauri::TitleBarStyle::Overlay)
                    .unwrap();
                main_window.set_traffic_lights_inset(12.0, 16.0).unwrap();

                // `hiddenTitle: true` from tauri.conf.json is not re-applied
                // after the runtime Overlay switch above, so the dev product
                // name ("raum [dev]") bleeds over the custom header. Force
                // NSWindowTitleVisibility::Hidden (= 1) directly.
                let ns_window = main_window.ns_window().unwrap().cast::<AnyObject>();
                #[allow(unsafe_code)]
                unsafe {
                    let _: () = msg_send![ns_window, setTitleVisibility: 1_isize];
                }
            }

            // Linux / Windows: remove native decorations so our custom
            // titlebar takes over.
            #[cfg(not(target_os = "macos"))]
            main_window.set_decorations(false).unwrap();

            // Show after all titlebar setup to avoid flashing native chrome.
            main_window.show().unwrap();

            // First-launch convenience: make `raum <dir>` work from a terminal
            // for direct-download installs without a manual menu click. Silent,
            // best-effort, off the startup thread (it touches the filesystem);
            // the "Install 'raum' Terminal Command" menu item is the explicit
            // fallback. Release-only — in dev the exe is the throwaway
            // target/debug binary, which we must not wire onto $PATH.
            #[cfg(target_os = "macos")]
            if !cfg!(debug_assertions) {
                std::thread::spawn(commands::cli::auto_install_shim_if_safe);
            }

            // A terminal cold-launch (`raum <dir>`) execs the bundled binary
            // directly — the macOS `raum-cli` wrapper uses `nohup … &`, not
            // LaunchServices — so the process is not made frontmost
            // automatically and `show()` alone doesn't activate the app. When a
            // CLI directory is pending, activate the window the same way the
            // already-running path does, otherwise the requested project opens
            // *behind* the terminal the user typed into. Peek (don't drain) the
            // pending slot; the frontend drains it via `cli_take_pending_open`.
            if app
                .state::<state::AppHandleState>()
                .pending_cli_open
                .lock()
                .is_ok_and(|g| g.is_some())
            {
                let _ = main_window.set_focus();
            }

            // §12.3 — register the three OS-level global shortcuts. Their
            // accelerators can be overridden via keybindings.toml; we look them
            // up through `merged_keymap` so user overrides take effect.
            register_global_shortcuts(app.handle());

            // Must come before the first pane can be created: the flag is
            // consulted at tmux-server birth, which is whatever `new_session`
            // runs first.
            bootstrap_tmux_tcc_policy(app);

            // Must come before `bootstrap_git_watchers` — the watchers take
            // the service's pulse sender so terminal-driven commits/stages
            // refresh the sidebar status.
            bootstrap_status_service(app);

            bootstrap_git_watchers(app);

            // §7.6 — bring up the hook-event UDS socket and bridge it into
            // the agent state machines. Failures here downgrade to the
            // silence heuristic; they never block startup.
            bootstrap_event_socket(app);

            // Silence/output fallback: periodic tick that advances
            // Working machines to Idle after `silence_threshold` of no
            // PTY output, and lets fresh output reclaim Working when a
            // follow-up start hook is missed.
            commands::agent::spawn_silence_tick(app.handle());

            // Apply the server-wide tmux options that make every PTY-attached
            // `tmux attach-session` client transparent (no prefix key, no
            // status bar, zero ESC delay, no synthesized focus/title escapes).
            // Idempotent — safe to re-run on every launch.
            // Consume an accepted "restart the terminal server" prompt. Must
            // run BEFORE the rehydrate below reads the socket: the whole point
            // is that rehydrate then sees a cold server and takes its
            // recover-after-reboot path, resuming each harness conversation.
            // No-op unless the user explicitly accepted the prompt last run.
            commands::server_restart::apply_pending_server_restart(app);

            bootstrap_apply_server_options(app);

            // Rehydrate harness state for tmux sessions that survived the
            // previous app run: live sessions are re-registered with a seeded
            // state machine + terminal-registry ghost so top-row counters and
            // hook-driven transitions work from the first frame of the webview,
            // live-but-untracked sessions are adopted as closable orphans, and
            // only then are day-old untracked leftovers age-reaped (the reap
            // runs AFTER adoption so it can never destroy recoverable work).
            bootstrap_rehydrate_sessions(app);

            // Reconcile the live tmux socket with the tracked-session set on a
            // 5-min timer and on window focus: any live session raum has no
            // record of is adopted so it surfaces as a closable orphan pane
            // rather than an invisible fd leak. The boot pass runs inside
            // `bootstrap_rehydrate_sessions`; this handles post-launch
            // appearances. Gated on the rehydrate-complete signal so a focus
            // event during launch can't race recovery.
            bootstrap_reconciler(app);

            // Detect a WKWebView whose WebContent process died during
            // screen lock (wry never surfaces the termination to Tauri)
            // and reload it instead of leaving a black, dead window.
            bootstrap_webview_health(app);

            // Intercept window close so the frontend can flush its debounced
            // writers (active-layout 500 ms, terminal snapshots 2 s) before the
            // webview is torn down — otherwise the last layout mutation and the
            // freshest scrollback are lost on quit (Contract 1).
            bootstrap_quit_flush(app);

            // 5-min fd-count probe. Existence of this line in the log
            // turns the next leak repro into "read one number" instead
            // of "replay the day from grep". macOS + Linux only;
            // Windows lacks `/dev/fd`.
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            spawn_fd_probe();

            // §11 — install the UNUserNotificationCenter delegate. Must
            // happen during `.setup` (before the first notification fires)
            // so click events route back to the frontend, including the
            // case where macOS relaunches raum after the user clicks an
            // unread notification while it was quit.
            #[cfg(target_os = "macos")]
            {
                // Skip when running unbundled (e.g. `task dev` launches
                // `target/debug/raum` directly): UNUserNotificationCenter
                // throws on a process with no `.app` parent and crashes the
                // app at startup. Release builds run from `Raum.app` and
                // proceed normally.
                if notifications::is_bundled() {
                    let handle = app.handle().clone();
                    let delegate = notifications::delegate::install(handle.clone());
                    let state: tauri::State<'_, state::AppHandleState> = app.state();
                    if let Ok(mut guard) = state.notification_delegate.lock() {
                        *guard = Some(delegate);
                    } else {
                        warn!("notification_delegate mutex poisoned during setup");
                    }
                } else {
                    info!(
                        "notifications: skipping UNUserNotificationCenter \
                         delegate install — process is not running from a \
                         .app bundle (dev mode)"
                    );
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build raum")
        .run(|app, event| {
            // Fallback quit-flush for non-window exits (e.g. Cmd+Q routed
            // through the app menu's Quit, or `tauri-plugin-process` exit).
            // The window `CloseRequested` path (see `bootstrap_quit_flush`)
            // handles the common close-button / Cmd+W case; this catches the
            // rest. Re-entrancy is guarded inside `begin_quit_flush_for_exit`,
            // and the dance's own `app.exit(0)` re-fires `ExitRequested`, which
            // we must NOT prevent the second time around.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // A non-`None` code means `app.exit(code)` was called
                // deliberately (including by our own quit task) — let it
                // proceed rather than re-intercepting.
                if code.is_none() && commands::lifecycle::begin_quit_flush_for_exit(app) {
                    api.prevent_exit();
                }
            }
        });
}

/// §7.6 — start the hook-event UDS socket, export `RAUM_EVENT_SOCK` so
/// every child harness inherits it, and spawn the drain task that feeds
/// events into the agent state machines.
///
/// Runs asynchronously on the tokio runtime; startup never blocks on
/// this. If binding the socket fails (e.g. the state dir is on a
/// read-only filesystem, or a stale `events.sock` from another raum
/// instance cannot be replaced) we log a warning and fall through to
/// the silence heuristic — the app must always launch.
///
/// The listener `JoinHandle` + socket path are parked on managed state
/// (`AppHandleState::event_socket`) for the Phase 2 selftest UI; the
/// `rx` receiver is swapped out (replaced with a closed-on-drop dummy)
/// so the drain loop below can own it without losing the rest of the
/// handle.
fn bootstrap_event_socket(app: &mut tauri::App) {
    let sock_path = paths::event_socket_path();
    let (bus_tx, prompt_bus_tx) = {
        let state: tauri::State<'_, state::AppHandleState> = app.state();
        // Make sure the bridge task is running _before_ we start draining
        // socket events — otherwise early transitions emitted before the
        // first `agent_spawn` call would be lost on the broadcast bus.
        commands::agent::ensure_bridge_running(app.handle(), &state.agent_events);
        (
            state.agent_events.tx.clone(),
            state.agent_events.prompt_tx.clone(),
        )
    };
    let app_handle = app.handle().clone();

    tauri::async_runtime::spawn(async move {
        let mut handle = match spawn_event_socket(&sock_path) {
            Ok(h) => h,
            Err(e) => {
                warn!(
                    path = %sock_path.display(),
                    error = %e,
                    "event socket: spawn failed; falling back to silence heuristic",
                );
                return;
            }
        };
        set_event_sock_env(&handle);
        info!(
            path = %handle.path.display(),
            "event socket: bound and RAUM_EVENT_SOCK exported",
        );

        // Phase 6: also take ownership of the socket `rx` receiver
        // while stashing a sibling (mpsc::Sender) that notification
        // channels can push wire events into. We use a merger task:
        // the socket's native rx + a secondary rx fed by the channel
        // tasks both converge on `drive_event_socket`. Implementation:
        // swap the handle's `rx` with a dummy, then create a brand-new
        // merged channel (`merged_tx`/`merged_rx`); forward the
        // original rx into `merged_tx` in a task, and publish
        // `merged_tx` on managed state so channels can push into the
        // same drain loop.
        let (_dummy_tx, dummy_rx) = tokio::sync::mpsc::channel::<raum_hooks::HookEvent>(1);
        let mut original_rx = std::mem::replace(&mut handle.rx, dummy_rx);

        let (merged_tx, merged_rx) =
            tokio::sync::mpsc::channel::<raum_hooks::HookEvent>(raum_hooks::PER_AGENT_BACKLOG);
        let channel_tx = merged_tx.clone();
        {
            let state: tauri::State<'_, state::AppHandleState> = app_handle.state();
            if let Ok(mut slot) = state.event_socket.lock() {
                *slot = Some(handle);
            }
            if let Ok(mut slot) = state.channel_event_tx.lock() {
                *slot = Some(channel_tx);
            }
        }

        // Forward native socket events into the merged stream. If the
        // merged consumer closes, just drop the forwarder.
        let merged_forward = merged_tx.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(ev) = original_rx.recv().await {
                if merged_forward.send(ev).await.is_err() {
                    break;
                }
            }
        });

        let bus = commands::agent::AgentEventBus {
            tx: bus_tx,
            prompt_tx: prompt_bus_tx,
        };
        commands::agent::drive_event_socket(merged_rx, bus, app_handle).await;
    });
}

/// Apply the transparent-client server options to the `-L raum` tmux server.
/// Runs once at app start on the tokio blocking pool. tmux lazily spawns the
/// server when the first session is created, so this call may emit "no server
/// running" warnings on a clean launch — those are absorbed silently.
fn bootstrap_apply_server_options(app: &mut tauri::App) {
    let state: tauri::State<'_, state::AppHandleState> = app.state();
    let tmux = state.tmux.clone();
    tauri::async_runtime::spawn(async move {
        let result = tokio::task::spawn_blocking(move || tmux.apply_server_options()).await;
        match result {
            Ok(Ok(())) => {
                info!("tmux server options applied");
            }
            Ok(Err(e)) => {
                warn!(error = %e, "tmux apply_server_options failed");
            }
            Err(e) => {
                warn!(error = %e, "tmux apply_server_options join failed");
            }
        }
    });
}

/// Maximum time `bootstrap_rehydrate_sessions` waits for the event
/// socket bootstrap to publish a `channel_event_tx` before proceeding
/// without one. 1 s is short enough that the UI never notices; if
/// binding failed entirely we fall back to silence-only machines (same
/// behaviour as before rehydrate existed).
const REHYDRATE_EVENT_SOCKET_WAIT: std::time::Duration = std::time::Duration::from_secs(1);

/// Per-attempt sleep while polling for `channel_event_tx`. 20 ms keeps
/// the total wait a handful of ticks in the happy path.
const REHYDRATE_EVENT_SOCKET_POLL: std::time::Duration = std::time::Duration::from_millis(20);

/// Rehydrate harness state on app launch.
///
/// Sequence (all on the tokio runtime, non-blocking for setup):
///
/// 1. Bounded wait (≤ `REHYDRATE_EVENT_SOCKET_WAIT`) for the event
///    socket bootstrap to publish `channel_event_tx`. When it's live,
///    `infer_reattach_hook_fallback` can tell hook-installed sessions
///    apart from silence-only ones; when it isn't, every session gets
///    the silence fallback (matches the pre-rehydrate behaviour).
/// 2. List live tmux sessions, read `state/sessions.toml`, GC orphan
///    snapshots (keep = live ∪ tracked; skipped entirely whenever the
///    live set is empty — a cold server is never a wipe trigger —
///    Contract 4), feed live + tracked into the
///    pure `rehydrate_plan`, then hand the plan to `apply_rehydrate_plan`.
///    Per-session failures are logged but don't abort the rest.
///    3/4. Apply the plan, then reconcile the other direction — adopt every
///    live-but-untracked session so it surfaces as a closable orphan.
/// 5. ONLY THEN age-reap (`reap_stale(1)`) any tmux leftover still
///    untracked after adoption. The reap deliberately runs AFTER adopt so
///    a live session whose tracking row was lost is never age-reaped out
///    from under recoverable work (Theme 8 — session-visibility invariant).
/// 6. Latch the rehydrate-done watch + emit `rehydrate:complete`
///    (Contract 2). Done on every exit path so a gated pane never hangs.
fn bootstrap_rehydrate_sessions(app: &mut tauri::App) {
    let app_handle = app.handle().clone();
    let state: tauri::State<'_, state::AppHandleState> = app.state();
    let tmux = state.tmux.clone();

    tauri::async_runtime::spawn(async move {
        // NOTE on ordering: the boot age-reap used to run FIRST, against a
        // `keep` set that — at boot — was only `state/sessions.toml` rows
        // (the in-memory registry is still empty here). A live session whose
        // tracked row was lost (a spawn that crashed before its tracking
        // write, a forgotten-while-alive row, leftovers from an older build,
        // a partial `sessions.toml`) was therefore age-reaped BEFORE step-5
        // reconcile could adopt it — destroying live, recoverable work and
        // violating the session-visibility invariant. The reap is now moved
        // AFTER reconcile (step 6) so every live tmux session is first adopted
        // (tracked row + ghost) and thus protected; age alone can no longer
        // kill a live session at boot.

        // 1. Wait (bounded) for the event-socket bootstrap to publish
        // `channel_event_tx`.
        let deadline = std::time::Instant::now() + REHYDRATE_EVENT_SOCKET_WAIT;
        loop {
            let ready = {
                let state: tauri::State<'_, state::AppHandleState> = app_handle.state();
                state
                    .channel_event_tx
                    .lock()
                    .ok()
                    .and_then(|g| g.clone())
                    .is_some()
            };
            if ready || std::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(REHYDRATE_EVENT_SOCKET_POLL).await;
        }

        // 2. Build the plan.
        let live_ids: std::collections::HashSet<String> = match tokio::task::spawn_blocking({
            let tmux = tmux.clone();
            move || tmux.list_sessions()
        })
        .await
        {
            Ok(Ok(sessions)) => sessions.into_iter().map(|s| s.id).collect(),
            Ok(Err(e)) => {
                warn!(error = %e, "rehydrate: tmux list_sessions failed; skipping");
                latch_rehydrate_done(&app_handle);
                return;
            }
            Err(e) => {
                warn!(error = %e, "rehydrate: list_sessions join failed");
                latch_rehydrate_done(&app_handle);
                return;
            }
        };

        // Read the tracked-session set BEFORE the snapshot GC so the GC keep
        // set can union it in (Contract 4). On a computer restart the `-L raum`
        // tmux server is gone, `list_sessions()` returns Ok(empty), and
        // `live_ids` is empty — GCing against the live set alone would wipe
        // EVERY snapshot, destroying the only cross-restart scrollback fallback
        // for exactly the rows we are about to classify as Recover. (Poisoned
        // lock: recover it rather than abort — read_sessions degrades to
        // default on a corrupt file, so the only loss is the tracked set.)
        let tracked = {
            let state: tauri::State<'_, state::AppHandleState> = app_handle.state();
            let store = state
                .config_store
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            store.read_sessions().unwrap_or_default().sessions
        };

        // GC orphaned terminal snapshots. A snapshot whose session id is in
        // NEITHER the live tmux set NOR the still-tracked `sessions.toml` set
        // belongs to a session killed while raum was down (or a one-shot
        // `terminal_kill` we missed during a crash). Run on the rehydrate task
        // so it overlaps with the rest of recovery and never blocks the UI.
        //
        // Skip the GC entirely whenever there are no live tmux sessions — the
        // classic post-reboot signature (the `-L raum` server is cold) — so a
        // cold socket can never be mistaken for "every session ended" and
        // trigger a total snapshot wipe. This must NOT depend on `tracked`:
        // after the Contract 5 quarantine change a torn/corrupt `sessions.toml`
        // degrades to `Ok(default)` => `tracked` empty (no error), so gating on
        // `!tracked.is_empty()` would let a torn-write reboot fall into the GC
        // with an empty keep set and wipe every snapshot (invariant 2). An
        // empty live set is never a legitimate reason to delete all snapshots;
        // there is nothing to reclaim against on a cold server anyway.
        // Forgotten (untracked) snapshots are simply left for the next WARM
        // boot — when `live_ids` is non-empty the GC runs with
        // keep = live ∪ tracked and reaps them then. That deferral is
        // acceptable; preserving recoverable scrollback wins over reclaiming a
        // few orphan blobs one boot late. (`list_sessions()` errors already
        // early-returned above without reaching the GC.)
        if live_ids.is_empty() {
            info!(
                tracked = tracked.len(),
                "rehydrate: tmux server cold (no live sessions); skipping snapshot \
                 gc to preserve cross-restart scrollback (orphans reclaimed on next \
                 warm boot)",
            );
        } else {
            let keep_ids: Vec<String> = live_ids
                .iter()
                .cloned()
                .chain(tracked.iter().map(|row| row.session_id.clone()))
                .collect();
            match tokio::task::spawn_blocking(move || {
                raum_core::snapshot_store::gc_orphans(&keep_ids)
            })
            .await
            {
                Ok(Ok(removed)) if removed > 0 => {
                    info!(
                        count = removed,
                        "rehydrate: reaped orphan terminal snapshots"
                    );
                }
                Ok(Ok(_)) => {}
                Ok(Err(e)) => {
                    warn!(error = %e, "rehydrate: snapshot gc_orphans failed");
                }
                Err(e) => {
                    warn!(error = %e, "rehydrate: snapshot gc_orphans join failed");
                }
            }
        }

        let plan = commands::agent_hydrate::rehydrate_plan(&tracked, &live_ids);

        // 3. Apply. The applier spawns inside the same task; it runs
        // quickly because all per-session work is in-memory registry
        // mutation + a couple of Tauri emits. An empty plan (no tracked
        // rows to replay) still falls through to the reconcile below so
        // live-but-untracked sessions are adopted rather than left invisible.
        let state: tauri::State<'_, state::AppHandleState> = app_handle.state();
        if plan.is_empty() {
            info!("rehydrate: no tracked rows to replay");
        } else {
            let _report = commands::agent_hydrate::apply_rehydrate_plan(&app_handle, &state, plan);
        }

        // 4. Reconcile the other direction: adopt every live tmux session that
        // rehydrate did NOT account for (no `sessions.toml` row — a spawn that
        // crashed before tracking, a forgotten-while-alive row, leftovers from
        // an older build). Without this they stay invisible to the frontend
        // and either leak fds or get silently age-reaped. Adoption writes a
        // tracked row + a live ghost so they surface in the orphan tray.
        match commands::terminal::reconcile_inner(&app_handle, &state).await {
            Ok(adopted) if !adopted.is_empty() => {
                info!(count = adopted.len(), ids = ?adopted, "rehydrate: adopted orphan tmux sessions");
            }
            Ok(_) => {}
            Err(e) => warn!(error = %e, "rehydrate: reconcile failed"),
        }

        // 5. Backstop age-reap, now that reconcile has adopted every live
        // session. `protected_session_ids` reflects the freshly-populated
        // registry + tracked set, so this only ever targets sessions that are
        // STILL untracked after adoption (effectively none on the boot path) —
        // it can no longer kill a live, recoverable session purely on age. We
        // keep it as a cheap guard against a leftover that appears in the
        // narrow window between adoption and this call. A protected-read or
        // reap failure is logged and skipped: a missing reap never blocks
        // launch, and never destroys data.
        let keep = match commands::terminal::protected_session_ids(&state) {
            Ok(ids) => Some(ids),
            Err(e) => {
                warn!(error = %e, "rehydrate: protected-session read failed; skipping boot reap");
                None
            }
        };
        if let Some(keep) = keep {
            match tokio::task::spawn_blocking({
                let tmux = tmux.clone();
                move || tmux.reap_stale(1, &keep)
            })
            .await
            {
                Ok(killed) if !killed.is_empty() => {
                    info!(
                        count = killed.len(),
                        ids = ?killed,
                        "rehydrate: age-reaped untracked tmux leftovers (post-adopt)",
                    );
                }
                Ok(_) => {}
                Err(e) => warn!(error = %e, "rehydrate: reap_stale join failed"),
            }
        }

        // 6. Latch the rehydrate-complete signal. The reconciler's focus/timer
        // triggers wait on this so they can't race the boot pass, and the
        // (now backstop-only) orphan reaper stays gated behind a fully
        // populated registry + tracked set. `latch_rehydrate_done` also emits
        // `rehydrate:complete` so a late-mounting pane that missed the watch
        // flip can still observe it (Contract 2); panes also poll
        // `terminal_rehydrate_ready`.
        latch_rehydrate_done(&app_handle);
    });
}

/// Flip the rehydrate-done watch to `true` and emit the `rehydrate:complete`
/// event (Contract 2). The watch is the authority a pane polls via
/// `terminal_rehydrate_ready`; the event lets an already-listening pane react
/// without polling. Called on the happy path AND on every early-return failure
/// path inside `bootstrap_rehydrate_sessions` so a pane gated on rehydrate
/// never hangs waiting for a signal that never fires.
fn latch_rehydrate_done<R: Runtime>(app: &tauri::AppHandle<R>) {
    let state: tauri::State<'_, state::AppHandleState> = app.state();
    // `send_replace` (not `send`): `watch::Sender::send` short-circuits with
    // `Err(SendError)` WITHOUT updating the stored value when there are zero
    // live receivers, which is the normal boot case here (the only long-lived
    // receiver lives inside `run_reconcile`, which usually isn't parked at this
    // instant). `send_replace` updates the latched value unconditionally, so a
    // pane that later polls `terminal_rehydrate_ready` actually observes `true`.
    // The separate `app.emit` below still drives the one-shot event path for
    // already-listening panes.
    state.rehydrate_done_tx.send_replace(true);
    if let Err(e) = app.emit("rehydrate:complete", true) {
        warn!(error = %e, "rehydrate: failed to emit rehydrate:complete");
    }
}

/// Spawn a long-lived task that reports the process's open-fd count
/// every 5 minutes. The 7 993 `git_watcher: notify error` warnings in
/// `raum.log.2026-04-27` told us *that* fds were exhausted but not when
/// the count started climbing or which user action did it. Counting
/// entries in `/dev/fd` is cheap (one `read_dir`) and uniquely
/// disambiguates "slow leak" from "single-step jump".
///
/// macOS + Linux only — Windows has no `/dev/fd` analogue.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn spawn_fd_probe() {
    use std::time::Duration;
    const INTERVAL: Duration = Duration::from_secs(300);

    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Skip the immediate first tick — let the app finish booting
        // before we report.
        tick.tick().await;
        loop {
            tick.tick().await;
            report_fd_count();
        }
    });
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn report_fd_count() {
    let count = match std::fs::read_dir("/dev/fd") {
        Ok(iter) => iter.count(),
        Err(e) => {
            warn!(error = %e, "fd_probe: read_dir(/dev/fd) failed");
            return;
        }
    };

    let soft = current_nofile_soft_limit();
    info!(fd_count = count, soft = soft, "raum: fd_count");
}

/// Read the current `RLIMIT_NOFILE` soft cap. Returns 0 on failure so
/// the log line is still useful (`soft=0` is obviously wrong and
/// indicates the probe couldn't read its budget).
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn current_nofile_soft_limit() -> u64 {
    use libc::{RLIMIT_NOFILE, getrlimit, rlimit};
    let mut lim = rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `getrlimit` writes through a valid `rlimit` pointer; we
    // own `lim` for the duration of the call.
    #[allow(unsafe_code)]
    let rc = unsafe { getrlimit(RLIMIT_NOFILE, &raw mut lim) };
    if rc == 0 { lim.rlim_cur } else { 0 }
}

/// Reconcile the live `-L raum` tmux socket with raum's tracked-session set on
/// a slow timer and on every window focus. Any live session raum has no record
/// of is ADOPTED (tracked row + live ghost) so it surfaces as a closable
/// orphan pane in the dock tray — the user closes it. raum never auto-kills a
/// live session it might still want; the invariant is "every live tmux session
/// is visible," not "kill everything untracked."
///
/// This replaces the old focus/timer `terminal_kill_orphans` auto-reaper,
/// which (a) silently destroyed live sessions and (b) raced relaunch by
/// firing against an empty registry. fd pressure (the
/// `git_watcher: notify error` EMFILE storm in `raum.log.2026-04-27`) is now
/// bounded by surfacing leaks for the user to close, plus the boot
/// `reap_stale(1)` backstop for sessions abandoned over a day. The boot pass
/// runs inside `bootstrap_rehydrate_sessions` (step 5); this covers sessions
/// that appear *after* launch (e.g. a spawn whose tracking write lost to a
/// crash).
fn bootstrap_reconciler(app: &mut tauri::App) {
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    const PERIODIC_INTERVAL: Duration = Duration::from_secs(300);
    // Focus fires on every unlock and app-switch — the most contended
    // instant of a wake (webview probes, status catch-up, frontend resync
    // all land there). Forking `tmux list-sessions` into that stampede is
    // redundant when a pass ran within the last minute, and even a due
    // pass can wait out the wake edge.
    const FOCUS_MIN_INTERVAL: Duration = Duration::from_secs(60);
    const FOCUS_SETTLE: Duration = Duration::from_millis(1500);

    let handle = app.handle().clone();
    let main_window = app.get_webview_window("main");
    // Tracks FOCUS-triggered passes only. The periodic timer deliberately
    // does not stamp it: `run_reconcile` can block up to 60 s on the
    // rehydrate gate, so a timer stamp taken after completion would push
    // the focus-suppression window out by an unpredictable amount — and
    // an occasional timer-adjacent focus pass is harmless (reconcile is
    // idempotent and never destructive).
    let last_focus_run: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));

    // Periodic reconcile every 5 minutes.
    let timer_handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(PERIODIC_INTERVAL);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // Skip the immediate first tick — the boot reconcile already ran
        // inside `bootstrap_rehydrate_sessions`.
        tick.tick().await;
        loop {
            tick.tick().await;
            run_reconcile(&timer_handle, "timer").await;
        }
    });

    // Window-focus reconcile. The callback runs on Tauri's event thread —
    // dispatch onto the async runtime so we don't block it.
    if let Some(win) = main_window {
        let focus_handle = handle.clone();
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(true) = event {
                // Check-and-stamp before the settle sleep so rapid focus
                // cycling collapses to one pass instead of queueing several.
                {
                    let Ok(mut last) = last_focus_run.lock() else {
                        return;
                    };
                    if last.is_some_and(|at| at.elapsed() < FOCUS_MIN_INTERVAL) {
                        debug!("reconcile: focus pass skipped — ran recently");
                        return;
                    }
                    *last = Some(Instant::now());
                }
                let h = focus_handle.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(FOCUS_SETTLE).await;
                    run_reconcile(&h, "focus").await;
                });
            }
        });
    } else {
        warn!("bootstrap_reconciler: main window not found");
    }
}

/// Webview health check. macOS sometimes kills the WKWebView WebContent
/// process while the screen is locked (suspension + memory/GPU pressure);
/// the page then stays black and dead. Two layers of recovery: on macOS a
/// swizzled `webViewWebContentProcessDidTerminate:` reloads the instant
/// WebKit reports the kill (usually still mid-lock), and on every
/// `Focused(true)` a patient probe sequence catches anything the callback
/// missed, reloading after ~6 s of total silence — a suspended-but-alive
/// page answers late, a dead one never does; see
/// `commands::webview_health` for the full story. Registered as a second
/// `on_window_event` handler; Tauri appends listeners, so this never
/// disturbs the orphan reaper's focus hook.
fn bootstrap_webview_health(app: &mut tauri::App) {
    let Some(win) = app.get_webview_window("main") else {
        warn!("bootstrap_webview_health: main window not found");
        return;
    };
    let handle = app.handle().clone();
    #[cfg(target_os = "macos")]
    commands::webview_health::install_terminate_hook(&win, handle.clone());
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(true) = event {
            commands::webview_health::on_focus_gained(&handle);
        }
    });
}

/// Quit-flush interceptor (Contract 1). Registers a `CloseRequested` handler on
/// the main window that prevents the immediate close, hands off to
/// `commands::lifecycle::begin_quit_flush` (which asks the frontend to flush its
/// debounced writers, waits for the ack with a bounded timeout, then exits), and
/// is re-entrancy-safe so the post-`app.exit` re-fire of `CloseRequested` falls
/// through. Registered as another `on_window_event` handler — Tauri appends
/// listeners (same pattern as `bootstrap_reconciler` / `bootstrap_webview_health`).
fn bootstrap_quit_flush(app: &mut tauri::App) {
    let Some(win) = app.get_webview_window("main") else {
        warn!("bootstrap_quit_flush: main window not found");
        return;
    };
    let handle = app.handle().clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if commands::lifecycle::begin_quit_flush(&handle) {
                // We took ownership: keep the window alive until the flush
                // task calls `app.exit(0)`. A second `CloseRequested` (Tauri
                // re-fires after exit) returns `false` and is NOT prevented.
                api.prevent_close();
            }
        }
    });
}

/// Run one reconcile pass. Quiet on the happy path so a 5-min timer doesn't
/// pollute the log; only logs when sessions were adopted or the call failed.
///
/// Gated on the rehydrate-complete signal (with a timeout): a `Focused(true)`
/// during early launch must not reconcile against a half-populated registry,
/// or it would adopt — as project-less orphans — sessions the boot rehydrate
/// is about to register with full metadata.
async fn run_reconcile(handle: &tauri::AppHandle, trigger: &'static str) {
    const GATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);
    let mut rehydrate_done = {
        let state: tauri::State<'_, state::AppHandleState> = handle.state();
        state.rehydrate_done_tx.subscribe()
    };
    if tokio::time::timeout(GATE_TIMEOUT, rehydrate_done.wait_for(|&done| done))
        .await
        .is_err()
    {
        warn!(
            trigger = trigger,
            "reconcile: timed out waiting for rehydrate-complete; proceeding anyway",
        );
    }

    let state: tauri::State<'_, state::AppHandleState> = handle.state();
    match commands::terminal::reconcile_inner(handle, &state).await {
        Ok(adopted) if !adopted.is_empty() => {
            info!(
                trigger = trigger,
                adopted = adopted.len(),
                "reconcile: adopted orphan tmux sessions",
            );
        }
        Ok(_) => {}
        Err(e) => {
            warn!(trigger = trigger, error = %e, "reconcile: failed");
        }
    }
}

/// Push `terminals.disclaim_tcc_responsibility` onto the tmux manager before
/// any pane can be created.
///
/// macOS attributes a pane's foreign app-data reads to the tmux server's TCC
/// "responsible process". Default (`false`) leaves that as raum.app — a
/// Developer-ID identity TCC can pin an "Allow" to permanently, and one Full
/// Disk Access tick covers every shell. `true` disclaims, matching iTerm2 /
/// WezTerm / Ghostty, at the cost of grants hanging off an ad-hoc-signed
/// Homebrew binary that TCC re-prompts for.
///
/// Read once here rather than at every `new_session`: the flag only matters at
/// server *birth*, and a running server can't be re-parented anyway. Changing
/// it therefore takes effect on the next cold server (relaunch after
/// `tmux -L raum kill-server`).
fn bootstrap_tmux_tcc_policy(app: &mut tauri::App) {
    let state: tauri::State<'_, state::AppHandleState> = app.state();
    // A poisoned lock or an unreadable config must not block startup — recover
    // the guard (same convention as `config_get`) and fall back to `false`,
    // which is the safe, prompt-once-then-durable behaviour.
    let disclaim = state
        .config_store
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .read_config()
        .is_ok_and(|cfg| cfg.terminals.disclaim_tcc_responsibility);
    state.tmux.set_disclaim_tcc(disclaim);
    if disclaim {
        info!("tmux server will be born with TCC responsibility disclaimed (opt-in)");
    }
}

/// Construct the backend worktree-status service and park it on managed
/// state. Also registers the window-focus hook that (a) pauses the
/// service's fallback ticks while the app is backgrounded and (b) triggers
/// a catch-up recompute on focus gain. Registered as another
/// `on_window_event` handler — Tauri appends listeners (same pattern as
/// `bootstrap_reconciler` / `bootstrap_webview_health`).
fn bootstrap_status_service(app: &mut tauri::App) {
    let svc = commands::worktree::WorktreeStatusService::new(app.handle().clone());
    let state: tauri::State<'_, state::AppHandleState> = app.state();
    if let Ok(mut slot) = state.status_service.lock() {
        *slot = Some(svc.clone());
    } else {
        warn!("bootstrap_status_service: status_service mutex poisoned");
    }

    if let Some(win) = app.get_webview_window("main") {
        win.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                svc.set_focused(*focused);
            }
        });
    } else {
        warn!("bootstrap_status_service: main window not found");
    }
}

/// Start a `GitHeadWatcher` for every already-registered project so branch
/// badges refresh automatically after startup. Failures per project are
/// logged and skipped — a bad repo never blocks launch.
fn bootstrap_git_watchers(app: &mut tauri::App) {
    let state: tauri::State<'_, state::AppHandleState> = app.state();
    let handle = app.handle().clone();
    let status_pulse = state
        .status_service
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|svc| svc.pulse_sender()));

    let slugs_and_roots: Vec<(String, std::path::PathBuf)> = {
        let Ok(store) = state.config_store.lock() else {
            warn!("bootstrap_git_watchers: config_store lock poisoned");
            return;
        };
        let slugs = match store.list_project_slugs() {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "bootstrap_git_watchers: list_project_slugs failed");
                return;
            }
        };
        slugs
            .into_iter()
            .filter_map(|slug| match store.read_project(&slug) {
                Ok(Some(p)) => Some((p.slug, p.root_path)),
                _ => None,
            })
            .collect()
    };

    let Ok(mut watchers) = state.git_watchers.lock() else {
        warn!("bootstrap_git_watchers: git_watchers lock poisoned");
        return;
    };
    for (slug, root) in slugs_and_roots {
        match commands::git_watcher::GitHeadWatcher::start(
            slug.clone(),
            &root,
            handle.clone(),
            status_pulse.clone(),
        ) {
            Ok(w) => {
                info!(id = %slug, "git_watcher: started");
                watchers.insert(slug, w);
            }
            Err(e) => warn!(id = %slug, error = %e, "git_watcher: start failed"),
        }
    }
}

/// Build the application menu. On macOS we expose only the app submenu
/// (About, Services, Hide, Quit); File/Edit/View/Window/Help are deliberately
/// omitted because raum drives every shortcut through the frontend keymap or
/// `tauri-plugin-global-shortcut` — the default menus would expose actions we
/// don't implement. On Linux/Windows the window runs decoration-less, so an
/// empty menu is a no-op.
///
/// The About item carries a runtime-loaded icon so the About panel shows the
/// raum mark even in `cargo tauri dev`, where the unbundled binary can't
/// resolve `icon.icns` via `CFBundleIconFile`.
fn build_app_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    #[cfg(target_os = "macos")]
    {
        let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/128x128@2x.png"))?;
        let about_metadata = AboutMetadataBuilder::new()
            .name(Some("raum"))
            .version(Some(env!("CARGO_PKG_VERSION")))
            .short_version(Some(env!("CARGO_PKG_VERSION")))
            .icon(Some(icon))
            .copyright(Some("© 2026 raum contributors"))
            .website(Some("https://github.com/andremonaco/raum"))
            .website_label(Some("github.com/andremonaco/raum"))
            .build();

        let check_updates_item =
            MenuItemBuilder::with_id(MENU_ID_CHECK_UPDATES, "Check for Updates…").build(app)?;

        let settings_item = MenuItemBuilder::with_id(MENU_ID_OPEN_SETTINGS, "Settings…")
            .accelerator("Cmd+,")
            .build(app)?;

        let install_cli_item =
            MenuItemBuilder::with_id(MENU_ID_INSTALL_CLI, "Install 'raum' Terminal Command")
                .build(app)?;

        let app_submenu = SubmenuBuilder::new(app, "raum")
            .item(&PredefinedMenuItem::about(
                app,
                Some("About raum"),
                Some(about_metadata),
            )?)
            .separator()
            .item(&check_updates_item)
            .separator()
            .item(&settings_item)
            .item(&install_cli_item)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;

        // Installing a custom menu on macOS replaces the default menu bar,
        // which would otherwise include the Edit submenu that binds
        // ⌘A / ⌘C / ⌘V / ⌘X / ⌘Z / ⇧⌘Z to the standard NSResponder actions.
        // Webviews rely on those menu items being present to route the
        // shortcuts into the focused text input — without them, typing into
        // a dialog's textbox can't copy or select-all. So re-add an Edit
        // submenu with just the predefined items.
        let edit_submenu = SubmenuBuilder::new(app, "Edit")
            .item(&PredefinedMenuItem::undo(app, None)?)
            .item(&PredefinedMenuItem::redo(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::cut(app, None)?)
            .item(&PredefinedMenuItem::copy(app, None)?)
            .item(&PredefinedMenuItem::paste(app, None)?)
            .item(&PredefinedMenuItem::select_all(app, None)?)
            .build()?;

        return Menu::with_items(app, &[&app_submenu, &edit_submenu]);
    }

    #[cfg(not(target_os = "macos"))]
    {
        Menu::new(app)
    }
}

/// §12.3 — register the OS-level global shortcuts (`focus-raum`,
/// `spawn-shell-global`). Each handler emits a `global-action-requested`
/// event carrying the action name; the frontend listens and dispatches.
/// Registration failures are logged and skipped so one bad accelerator can
/// never take the app down.
fn register_global_shortcuts<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let store = ConfigStore::default();
    let keymap = keymap::merged_keymap(&store);
    let shortcuts = app.global_shortcut();

    for entry in keymap.into_iter().filter(|e| e.global) {
        let action = entry.action.clone();
        let app_for_handler = app.clone();
        let result =
            shortcuts.on_shortcut(entry.accelerator.as_str(), move |_app, _shortcut, event| {
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                if let Err(e) = app_for_handler.emit("global-action-requested", action.clone()) {
                    warn!(
                        action = %action,
                        error = %e,
                        "global shortcut: emit failed"
                    );
                }
            });
        if let Err(e) = result {
            warn!(
                action = %entry.action,
                accelerator = %entry.accelerator,
                error = %e,
                "global shortcut: registration failed"
            );
        } else {
            info!(
                action = %entry.action,
                accelerator = %entry.accelerator,
                "global shortcut registered"
            );
        }
    }
}
