//! §11 — selectively dismiss delivered OS notifications by `(session_id, kind)`.
//!
//! Inverse of [`crate::notifications::send::notifications_send`]. The
//! frontend invokes this on two triggers:
//!
//! 1. A project tab becomes the active tab → dismiss every `kind == "done"`
//!    notification owned by a session in that project so the dock badge and
//!    Notification Center entry both clear.
//! 2. A harness leaves the `waiting` state → dismiss every
//!    `kind == "needs_input"` notification for that session, so the OS
//!    Notification Center entry disappears alongside the in-memory
//!    permission cleanup the frontend already performs.
//!
//! macOS owns the meaningful path. `notify-rust` on Linux gives us no
//! way to round-trip identifiers through the freedesktop daemon — the
//! `send_linux` path doesn't even encode the session id — so the Linux
//! path is a no-op. Same asymmetry as `send_linux`.

use serde::Deserialize;
use tauri::{AppHandle, Runtime};
use tracing::info;

#[cfg(any(target_os = "macos", test))]
use crate::notifications::send::IDENTIFIER_SEPARATOR;

/// Arguments for [`notifications_clear`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearNotificationsArgs {
    /// Originating session id whose notifications should be dismissed.
    pub session_id: String,
    /// Kind tags to dismiss (e.g. `["done"]` or `["needs_input"]`). An
    /// empty vec is a no-op so callers can always pass a freshly computed
    /// list without a special case.
    pub kinds: Vec<String>,
}

/// Selectively dismiss delivered notifications matching `session_id` and any
/// of `kinds`. Best-effort: errors are logged and folded into `Ok(())` so
/// notification cleanup never aborts a state-change handler.
#[tauri::command]
pub async fn notifications_clear<R: Runtime>(
    #[allow(unused_variables)] app: AppHandle<R>,
    args: ClearNotificationsArgs,
) -> Result<(), String> {
    info!(
        session_id = %args.session_id,
        kinds = ?args.kinds,
        "notifications_clear: requested",
    );

    if args.session_id.is_empty() || args.kinds.is_empty() {
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        clear_macos(&args.session_id, &args.kinds).await;
    }

    #[cfg(not(target_os = "macos"))]
    {
        tracing::debug!("notifications_clear: not supported on this platform");
    }

    Ok(())
}

/// Build the prefix every identifier of `(session_id, kind)` starts with.
/// Pure for testing.
#[cfg(any(target_os = "macos", test))]
fn identifier_prefix(session_id: &str, kind: &str) -> String {
    format!("{session_id}{IDENTIFIER_SEPARATOR}{kind}{IDENTIFIER_SEPARATOR}")
}

/// Filter `identifiers` down to those that match `session_id` and one of
/// `kinds`. Pure for testing — exercised both by unit tests and by the
/// macOS dispatch path so we don't have to mock UNUserNotificationCenter to
/// verify the identifier-matching logic.
#[cfg(any(target_os = "macos", test))]
fn filter_matching(identifiers: &[String], session_id: &str, kinds: &[String]) -> Vec<String> {
    let prefixes: Vec<String> = kinds
        .iter()
        .filter(|k| !k.is_empty())
        .map(|k| identifier_prefix(session_id, k))
        .collect();
    if prefixes.is_empty() {
        return Vec::new();
    }
    identifiers
        .iter()
        .filter(|id| prefixes.iter().any(|p| id.starts_with(p.as_str())))
        .cloned()
        .collect()
}

#[cfg(target_os = "macos")]
async fn clear_macos(session_id: &str, kinds: &[String]) {
    use std::ptr::NonNull;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2_foundation::{NSArray, NSString};
    use objc2_user_notifications::{UNNotification, UNUserNotificationCenter};
    use tracing::{debug, warn};

    let (tx, rx) = tokio::sync::oneshot::channel::<Vec<String>>();

    let session_id_owned = session_id.to_string();
    let kinds_owned: Vec<String> = kinds.to_vec();

    // Stage 1: enumerate delivered notifications and stream the matching
    // identifiers back as plain `String`s. We cannot retain `NSString`s
    // across the await because `Retained<NSString>` is `!Send`, and the
    // outer `async fn` future must be `Send` for Tauri.
    {
        let center = UNUserNotificationCenter::currentNotificationCenter();

        let tx_cell = std::sync::Mutex::new(Some(tx));
        let completion = RcBlock::new(move |notifications: NonNull<NSArray<UNNotification>>| {
            #[allow(unsafe_code)]
            let arr: &NSArray<UNNotification> = unsafe { notifications.as_ref() };

            let mut all_ids: Vec<String> = Vec::with_capacity(arr.count());
            for notification in arr.iter() {
                let identifier = notification.request().identifier();
                all_ids.push(identifier.to_string());
            }
            let matches = filter_matching(&all_ids, &session_id_owned, &kinds_owned);

            if let Ok(mut guard) = tx_cell.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(matches);
                }
            }
        });

        center.getDeliveredNotificationsWithCompletionHandler(&completion);
    }

    let matches = match tokio::time::timeout(Duration::from_secs(2), rx).await {
        Ok(Ok(ids)) => ids,
        Ok(Err(_)) => {
            warn!("notifications_clear: completion handler dropped");
            return;
        }
        Err(_) => {
            warn!("notifications_clear: getDeliveredNotifications timed out");
            return;
        }
    };

    if matches.is_empty() {
        debug!(session_id, "notifications_clear: nothing matched");
        return;
    }

    info!(
        session_id,
        count = matches.len(),
        "notifications_clear: dismissing matched notifications"
    );

    // Stage 2: rebuild the matched identifiers as `NSString`s and ask the
    // center to drop them. Both delivered and pending — the latter is a
    // belt-and-braces call (we never schedule, so it's a no-op today) so
    // any future scheduled-trigger work can't accidentally leak past this
    // command.
    {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let strings: Vec<objc2::rc::Retained<NSString>> =
            matches.iter().map(|s| NSString::from_str(s)).collect();
        let refs: Vec<&NSString> = strings.iter().map(|s| s.as_ref()).collect();
        let array = NSArray::from_slice(&refs);

        center.removeDeliveredNotificationsWithIdentifiers(&array);
        center.removePendingNotificationRequestsWithIdentifiers(&array);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_prefix_uses_unit_separator() {
        let prefix = identifier_prefix("sess-1", "done");
        assert_eq!(
            prefix,
            format!("sess-1{IDENTIFIER_SEPARATOR}done{IDENTIFIER_SEPARATOR}")
        );
    }

    #[test]
    fn filter_matching_picks_session_and_kind() {
        let ids = vec![
            format!("sess-1{IDENTIFIER_SEPARATOR}done{IDENTIFIER_SEPARATOR}uuid-1"),
            format!("sess-1{IDENTIFIER_SEPARATOR}needs_input{IDENTIFIER_SEPARATOR}uuid-2"),
            format!("sess-2{IDENTIFIER_SEPARATOR}done{IDENTIFIER_SEPARATOR}uuid-3"),
            // Legacy two-part identifier (no kind) — must not match.
            format!("sess-1{IDENTIFIER_SEPARATOR}uuid-legacy"),
        ];

        let matched = filter_matching(&ids, "sess-1", &["done".to_string()]);
        assert_eq!(matched, vec![ids[0].clone()]);

        let matched_input = filter_matching(&ids, "sess-1", &["needs_input".to_string()]);
        assert_eq!(matched_input, vec![ids[1].clone()]);

        let matched_both = filter_matching(
            &ids,
            "sess-1",
            &["done".to_string(), "needs_input".to_string()],
        );
        assert_eq!(matched_both, vec![ids[0].clone(), ids[1].clone()]);
    }

    #[test]
    fn filter_matching_skips_other_sessions_and_legacy_format() {
        let ids = vec![
            format!("sess-1{IDENTIFIER_SEPARATOR}done{IDENTIFIER_SEPARATOR}uuid-1"),
            format!("sess-1{IDENTIFIER_SEPARATOR}uuid-legacy"),
            "plain-uuid-no-separator".to_string(),
        ];
        let matched = filter_matching(&ids, "sess-1", &["done".to_string()]);
        assert_eq!(matched, vec![ids[0].clone()]);
    }

    #[test]
    fn filter_matching_with_empty_kinds_returns_nothing() {
        let ids = vec![format!(
            "sess-1{IDENTIFIER_SEPARATOR}done{IDENTIFIER_SEPARATOR}uuid"
        )];
        assert!(filter_matching(&ids, "sess-1", &[]).is_empty());
    }

    #[test]
    fn filter_matching_skips_empty_kind_entries() {
        let ids = vec![format!(
            "sess-1{IDENTIFIER_SEPARATOR}done{IDENTIFIER_SEPARATOR}uuid"
        )];
        let matched = filter_matching(&ids, "sess-1", &[String::new()]);
        assert!(matched.is_empty());
    }
}
