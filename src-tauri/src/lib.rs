//! raum Tauri host. Entry point wires plugins and exposes the command surface.

mod cli;
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
use tracing::{info, warn};

/// ID of the "Settings…" item in the macOS app submenu. Clicking it emits
/// `menu-action` with this string as the payload so the frontend can route
/// the event to the same handler as the in-app settings gear.
#[cfg(target_os = "macos")]
const MENU_ID_OPEN_SETTINGS: &str = "open-settings";

pub fn run() {
    // §2.7 — no user CLI surface. Inspect args; print GUI-only --help and exit before window.
    if !cli::handle_args() {
        return;
    }

    let _log_guard = logging::init_tracing(&paths::logs_dir());
    info!("raum starting");

    // Bundled apps launched from Finder inherit a minimal PATH that doesn't
    // see Homebrew, nvm, or other dev tool locations — so harness binaries
    // (`claude`, `codex`, `opencode`) fail to resolve. Probe the user's
    // login shell once here, before any `which::which()` call runs.
    path_env::augment_process_path();

    tauri::Builder::default()
        .plugin(tauri_plugin_decorum::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
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
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .menu(build_app_menu)
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if let Err(e) = app.emit("menu-action", id) {
                warn!(menu_id = %id, error = %e, "menu-action emit failed");
            }
        })
        .manage(state::AppHandleState::default())
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::config_get,
            commands::config_mark_onboarded,
            commands::active_layout_get,
            commands::active_layout_save,
            commands::os_info,
            commands::keymap_get_defaults,
            commands::keymap_get_effective,
            commands::keymap_set_override,
            commands::keymap_clear_override,
            commands::prereqs_check,
            commands::harnesses_check,
            commands::terminal::terminal_spawn,
            commands::terminal::terminal_reattach,
            commands::terminal::terminal_kill,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_list,
            commands::terminal::terminal_send_keys,
            commands::terminal::terminal_paste_paths,
            commands::terminal::terminal_pane_context,
            commands::terminal::terminal_reap_stale,
            commands::agent::agent_list,
            commands::agent::agent_spawn,
            commands::agent::agent_state,
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
            commands::worktree_branches,
            commands::worktree_branch_merged,
            commands::worktree_remove,
            commands::worktree_config_write,
            // §9 — sidebar surface (Wave 3C).
            commands::worktree_status,
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
            commands::config_set_harness_flags,
            commands::config_set_worktree_path_pattern,
            commands::config_set_appearance_theme,
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
            // Devtools — opened via keyboard shortcut since the native
            // right-click "Inspect" entry is globally suppressed.
            commands::devtools::open_devtools,
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

            // §12.3 — register the three OS-level global shortcuts. Their
            // accelerators can be overridden via keybindings.toml; we look them
            // up through `merged_keymap` so user overrides take effect.
            register_global_shortcuts(app.handle());

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
            bootstrap_apply_server_options(app);

            // Rehydrate harness state for tmux sessions that survived the
            // previous app run. Absorbs the boot-time reap (stale tmux
            // sessions older than one day are killed first, their tracked
            // rows are then forgotten in `sessions.toml`, and the remaining
            // live sessions are re-registered with a seeded state machine
            // + terminal-registry ghost so top-row counters and hook-driven
            // transitions work from the first frame of the webview).
            bootstrap_rehydrate_sessions(app);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed while running raum");
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
    let bus_tx = {
        let state: tauri::State<'_, state::AppHandleState> = app.state();
        // Make sure the bridge task is running _before_ we start draining
        // socket events — otherwise early transitions emitted before the
        // first `agent_spawn` call would be lost on the broadcast bus.
        commands::agent::ensure_bridge_running(app.handle(), &state.agent_events);
        state.agent_events.tx.clone()
    };
    let app_handle = app.handle().clone();

    tauri::async_runtime::spawn(async move {
        let mut handle = match spawn_event_socket(&sock_path).await {
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

        let bus = commands::agent::AgentEventBus { tx: bus_tx };
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
/// 1. `tmux.reap_stale(1)` — kill any session older than one day on
///    the `-L raum` socket. Absorbs the previous `bootstrap_reap_stale`
///    so reap happens BEFORE we classify live vs. dead tracked rows.
/// 2. Bounded wait (≤ `REHYDRATE_EVENT_SOCKET_WAIT`) for the event
///    socket bootstrap to publish `channel_event_tx`. When it's live,
///    `infer_reattach_hook_fallback` can tell hook-installed sessions
///    apart from silence-only ones; when it isn't, every session gets
///    the silence fallback (matches the pre-rehydrate behaviour).
/// 3. List live tmux sessions, read `state/sessions.toml`, feed both
///    into the pure `rehydrate_plan`, then hand the plan to
///    `apply_rehydrate_plan`. Per-session failures are logged but
///    don't abort the rest of the rehydrate.
fn bootstrap_rehydrate_sessions(app: &mut tauri::App) {
    let app_handle = app.handle().clone();
    let state: tauri::State<'_, state::AppHandleState> = app.state();
    let tmux = state.tmux.clone();

    tauri::async_runtime::spawn(async move {
        // 1. Reap stale tmux sessions first so they disappear from
        // `list_sessions()` before we build the plan.
        let killed = match tokio::task::spawn_blocking({
            let tmux = tmux.clone();
            move || tmux.reap_stale(1)
        })
        .await
        {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "rehydrate: reap_stale join failed");
                Vec::new()
            }
        };
        if !killed.is_empty() {
            info!(
                count = killed.len(),
                ids = ?killed,
                "rehydrate: killed orphan tmux sessions",
            );
        }

        // 2. Wait (bounded) for the event-socket bootstrap to publish
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

        // 3. Build the plan.
        let live_ids: std::collections::HashSet<String> = match tokio::task::spawn_blocking({
            let tmux = tmux.clone();
            move || tmux.list_sessions()
        })
        .await
        {
            Ok(Ok(sessions)) => sessions.into_iter().map(|s| s.id).collect(),
            Ok(Err(e)) => {
                warn!(error = %e, "rehydrate: tmux list_sessions failed; skipping");
                return;
            }
            Err(e) => {
                warn!(error = %e, "rehydrate: list_sessions join failed");
                return;
            }
        };

        let tracked = {
            let state: tauri::State<'_, state::AppHandleState> = app_handle.state();
            let Ok(store) = state.config_store.lock() else {
                warn!("rehydrate: config_store lock poisoned");
                return;
            };
            store.read_sessions().unwrap_or_default().sessions
        };

        let plan = commands::agent_hydrate::rehydrate_plan(&tracked, &live_ids);
        if plan.is_empty() {
            info!("rehydrate: nothing to do");
            return;
        }

        // 4. Apply. The applier spawns inside the same task; it runs
        // quickly because all per-session work is in-memory registry
        // mutation + a couple of Tauri emits.
        let state: tauri::State<'_, state::AppHandleState> = app_handle.state();
        let _report = commands::agent_hydrate::apply_rehydrate_plan(&app_handle, &state, plan);
    });
}

/// Start a `GitHeadWatcher` for every already-registered project so branch
/// badges refresh automatically after startup. Failures per project are
/// logged and skipped — a bad repo never blocks launch.
fn bootstrap_git_watchers(app: &mut tauri::App) {
    let state: tauri::State<'_, state::AppHandleState> = app.state();
    let handle = app.handle().clone();

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
        match commands::git_watcher::GitHeadWatcher::start(slug.clone(), &root, handle.clone()) {
            Ok(w) => {
                info!(slug = %slug, "git_watcher: started");
                watchers.insert(slug, w);
            }
            Err(e) => warn!(slug = %slug, error = %e, "git_watcher: start failed"),
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

        let settings_item = MenuItemBuilder::with_id(MENU_ID_OPEN_SETTINGS, "Settings…")
            .accelerator("Cmd+,")
            .build(app)?;

        let app_submenu = SubmenuBuilder::new(app, "raum")
            .item(&PredefinedMenuItem::about(
                app,
                Some("About raum"),
                Some(about_metadata),
            )?)
            .separator()
            .item(&settings_item)
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
