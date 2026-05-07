//! Tauri-IPC bridge for the disk-backed terminal-snapshot store.
//!
//! The frontend's `terminalSnapshotPersistence.ts` invokes these commands
//! instead of writing to localStorage. localStorage isn't a safe target on
//! macOS WebKit (~5 MiB cap, evictable under the 7-day storage policy) and
//! we want snapshots to live next to raum's other state so a kill /
//! shutdown can reliably clean them up — which `raum-core::snapshot_store`
//! handles. See `crates/raum-core/src/snapshot_store.rs`.

use raum_core::snapshot_store;

/// Persist a serialized xterm snapshot for `session_id`. Bytes are an
/// already-gzipped `SerializeAddon` blob; we don't interpret them. Returns
/// `Ok(false)` if the snapshot is over the size cap so the caller can
/// re-serialize with a smaller scrollback.
#[tauri::command]
pub async fn terminal_snapshot_persist(session_id: String, bytes: Vec<u8>) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || snapshot_store::persist(&session_id, &bytes))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("persist snapshot: {e}"))
}

/// Load a previously persisted snapshot. Returns `None` when no snapshot
/// exists for the session — the frontend should treat that as "no replay".
#[tauri::command]
pub async fn terminal_snapshot_load(session_id: String) -> Result<Option<Vec<u8>>, String> {
    tokio::task::spawn_blocking(move || snapshot_store::load(&session_id))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("load snapshot: {e}"))
}

/// Explicitly drop a snapshot. Wired to the frontend's "rotate session id"
/// path (e.g. provider replacement) so the old session's snapshot doesn't
/// linger on disk when the id is retired before the pane death monitor
/// fires.
#[tauri::command]
pub async fn terminal_snapshot_delete(session_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || snapshot_store::delete_for_session(&session_id))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("delete snapshot: {e}"))
}
