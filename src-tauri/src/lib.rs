//! raum Tauri host. Entry point wires plugins and exposes the command surface.

mod cli;
mod commands;
mod keymap;
mod notifications;
mod state;

use raum_core::logging;
use raum_core::paths;
use raum_core::store::ConfigStore;
use tauri::{Emitter, Manager};
#[cfg(target_os = "macos")]
use tauri_plugin_decorum::WebviewWindowExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tracing::{info, warn};

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
            commands::worktree_preset_get,
            commands::worktree_preset_set,
            commands::worktree_config_write,
            // §9 — sidebar surface (Wave 3C).
            commands::worktree_status,
            commands::git_stage,
            commands::git_unstage,
            commands::git_diff,
            commands::quickfire_history_get,
            commands::quickfire_history_push,
            commands::config_set_sidebar_width,
            // §10.2 — layout preset CRUD (Wave 3D).
            commands::layouts::layouts_list,
            commands::layouts::layouts_save,
            commands::layouts::layouts_delete,
            // §11 — notifications surface (Wave 3E).
            commands::notifications::set_dock_badge,
            commands::notifications::notifications_focus_main,
            commands::notifications::notifications_mark_hint_shown,
            commands::notifications::config_set_notifications,
            commands::notifications::notifications_list_system_sounds,
            commands::notifications::notifications_read_sound_bytes,
            commands::config_set_harness_flags,
            // Global search — file search over a project's root or arbitrary path.
            commands::search::project_find_files,
            commands::search::search_files_in_path,
            // File editor — read/write files on behalf of the frontend.
            commands::files::file_read,
            commands::files::file_write,
            // Updater — persists the "check on launch" pref; actual
            // check/install happen via tauri-plugin-updater directly.
            commands::updater::config_set_updater_check_on_launch,
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed while running raum");
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
