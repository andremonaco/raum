//! raum Tauri host. Entry point wires plugins and exposes the command surface.

mod cli;
mod commands;
mod keymap;
mod notifications;
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
            commands::terminal::terminal_reap_stale,
            commands::agent::agent_list,
            commands::agent::agent_spawn,
            commands::agent::agent_state,
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
            commands::worktree_remove,
            commands::worktree_config_write,
            // §9 — sidebar surface (Wave 3C).
            commands::worktree_status,
            commands::git_stage,
            commands::git_unstage,
            commands::git_diff,
            commands::quickfire_history_get,
            commands::quickfire_history_push,
            commands::config_set_sidebar_width,
            // §11 — notifications surface (Wave 3E).
            commands::notifications::set_dock_badge,
            commands::notifications::notifications_focus_main,
            commands::notifications::notifications_mark_hint_shown,
            commands::notifications::config_set_notifications,
            commands::notifications::notifications_list_system_sounds,
            commands::notifications::notifications_read_sound_bytes,
            commands::config_set_harness_flags,
            commands::config_set_worktree_path_pattern,
            // Global search — file search over a project's root or arbitrary path.
            commands::search::project_find_files,
            commands::search::search_files_in_path,
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
                main_window
                    .set_title_bar_style(tauri::TitleBarStyle::Overlay)
                    .unwrap();
                main_window.set_traffic_lights_inset(12.0, 16.0).unwrap();
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

            // §3.7 — boot-time reap of tmux sessions older than one day.
            // Reattach (`terminal_reattach`) will pick up anything the user
            // still has open; anything left after a day is an orphan from a
            // closed project or a crashed instance and would otherwise leak
            // memory on the `-L raum` socket indefinitely.
            bootstrap_reap_stale(app);

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

        // Move the receiver into the drain loop while keeping the rest
        // of the handle (path + listener `JoinHandle`) alive on managed
        // state so the Phase 2 selftest UI can read it. We swap `rx`
        // with a dummy closed receiver instead of cloning because
        // `mpsc::Receiver` is not `Clone`; the dummy has no senders so
        // it never yields items.
        let (_dummy_tx, dummy_rx) = tokio::sync::mpsc::channel::<raum_hooks::HookEvent>(1);
        let rx = std::mem::replace(&mut handle.rx, dummy_rx);
        {
            let state: tauri::State<'_, state::AppHandleState> = app_handle.state();
            if let Ok(mut slot) = state.event_socket.lock() {
                *slot = Some(handle);
            }
        }
        let bus = commands::agent::AgentEventBus { tx: bus_tx };
        commands::agent::drive_event_socket(rx, bus, app_handle).await;
    });
}

/// Reap tmux sessions older than one day on the `-L raum` socket. Runs
/// once at app start on the tokio blocking pool so it can't delay the UI.
/// Reattach (`terminal_reattach`) will have already picked up anything the
/// user still has open in `active-layout.toml`; what's left is either from
/// a closed project, a crashed instance, or an abandoned dev iteration —
/// those would otherwise accumulate forever (we've observed 100+ orphans
/// after a few days of development).
fn bootstrap_reap_stale(app: &mut tauri::App) {
    let state: tauri::State<'_, state::AppHandleState> = app.state();
    let tmux = state.tmux.clone();
    tauri::async_runtime::spawn(async move {
        let killed = match tokio::task::spawn_blocking(move || tmux.reap_stale(1)).await {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "reap_stale: join failed");
                return;
            }
        };
        if !killed.is_empty() {
            info!(count = killed.len(), ids = ?killed, "reap_stale: killed orphan tmux sessions");
        }
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
