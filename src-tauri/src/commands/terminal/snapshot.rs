//! Tauri-IPC bridge for the disk-backed terminal-snapshot store.
//!
//! The frontend's `terminalSnapshotPersistence.ts` invokes these commands
//! instead of writing to localStorage. localStorage isn't a safe target on
//! macOS WebKit (~5 MiB cap, evictable under the 7-day storage policy) and
//! we want snapshots to live next to raum's other state so a kill /
//! shutdown can reliably clean them up — which `raum-core::snapshot_store`
//! handles. See `crates/raum-core/src/snapshot_store.rs`.
//!
//! Payloads ride the IPC as raw bytes in both directions. Tauri serializes
//! a `Vec<u8>` command argument/return as a JSON *number array* — a ~5×
//! text blowup that the WebView then parses element-by-element, which for a
//! snapshot near the 16 MiB cap means tens of MB of JSON on the reload
//! path. Instead, persist takes the whole request body as bytes (session id
//! in the [`SESSION_ID_HEADER`] header) and load returns a raw
//! [`tauri::ipc::Response`], which `invoke` resolves to an `ArrayBuffer`.

use raum_core::snapshot_store;
use tauri::ipc::{InvokeBody, InvokeResponseBody};

/// Header carrying the session id on the raw-bytes persist request — the
/// body is the snapshot itself, so scalar args have to travel out of band.
const SESSION_ID_HEADER: &str = "x-raum-session-id";

/// Persist a serialized xterm snapshot for the session named in the
/// [`SESSION_ID_HEADER`] request header; the request body is the raw
/// `SerializeAddon` VT stream. Returns `Ok(false)` if the snapshot is over
/// the size cap so the caller can re-serialize with a smaller scrollback.
#[tauri::command]
pub async fn terminal_snapshot_persist(request: tauri::ipc::Request<'_>) -> Result<bool, String> {
    let session_id = request
        .headers()
        .get(SESSION_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("missing {SESSION_ID_HEADER} header"))?
        .to_owned();
    let bytes: Vec<u8> = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        // postMessage fallback transport: the ArrayBuffer arrives as a JSON
        // number array instead of a raw body.
        InvokeBody::Json(value) => serde_json::from_value(value.clone())
            .map_err(|e| format!("snapshot body is not a byte array: {e}"))?,
    };
    tokio::task::spawn_blocking(move || snapshot_store::persist(&session_id, &bytes))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("persist snapshot: {e}"))
}

/// Load a previously persisted snapshot as a raw-bytes response. "No
/// snapshot" collapses to an empty body — the frontend already treats
/// zero-length as "no replay".
#[tauri::command]
pub async fn terminal_snapshot_load(session_id: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tokio::task::spawn_blocking(move || snapshot_store::load(&session_id))
        .await
        .map_err(|e| format!("spawn_blocking join: {e}"))?
        .map_err(|e| format!("load snapshot: {e}"))?;
    Ok(tauri::ipc::Response::new(InvokeResponseBody::Raw(
        bytes.unwrap_or_default(),
    )))
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
