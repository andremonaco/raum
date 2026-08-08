//! §11 — OS notification send path.
//!
//! Replaces `tauri-plugin-notification`'s legacy `NSUserNotification`
//! pipeline (via `mac-notification-sys`) with a direct
//! `UNUserNotificationCenter.add` call on macOS, and `notify-rust` over
//! zbus on Linux. The legacy path silently no-ops on modern macOS even
//! when the user has explicitly granted permission, which is exactly
//! what the user reported in the production Homebrew build.
//!
//! The notification's `sessionId` is round-tripped via the request
//! identifier — we encode it as `"<sessionId>\x1f<uuid>"` (ASCII unit
//! separator) so the click delegate can pull the originating session
//! back out without needing an `NSDictionary<NSString, NSObject>`
//! `userInfo` payload. A permission request appends its `requestId` as a
//! fourth field so the Allow/Deny action handler can reply without any
//! extra bookkeeping.
//!
//! Linux stays click-to-focus only: `notify-rust` can render freedesktop
//! actions, but reading the chosen one means keeping the
//! `NotificationHandle` parked on a blocking thread for the whole
//! lifetime of the banner and probing the daemon for the `actions`
//! capability first. The in-app Attention rail already covers Linux, so
//! v1 skips it.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tracing::{info, warn};

/// Bytes used to separate the `sessionId` prefix from the random suffix
/// inside a `UNNotificationRequest.identifier`. ASCII Unit Separator —
/// not a character that should ever appear in a raum session id.
#[cfg(any(target_os = "macos", test))]
pub const IDENTIFIER_SEPARATOR: char = '\x1f';

/// The `kind` tag that marks a notification as a permission prompt. Only
/// these get Allow/Deny action buttons.
#[cfg(any(target_os = "macos", test))]
pub const NEEDS_INPUT_KIND: &str = "needs_input";

/// `UNNotificationCategory` identifier carrying the Allow/Deny actions.
/// Registered once in [`crate::notifications::delegate::install`].
#[cfg(target_os = "macos")]
pub const PERMISSION_CATEGORY: &str = "raum.permission";

/// Action identifiers inside [`PERMISSION_CATEGORY`].
#[cfg(target_os = "macos")]
pub const ALLOW_ACTION: &str = "raum.allow";
#[cfg(target_os = "macos")]
pub const DENY_ACTION: &str = "raum.deny";

/// Arguments for [`notifications_send`]. Kept small on purpose; sound
/// playback continues to flow through `notifications_play_sound` so we
/// don't double-ping when the user has both an OS sound and the raum
/// custom sound configured.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendNotificationArgs {
    pub title: String,
    pub body: String,
    /// Optional originating session id. Round-trips through the OS as the
    /// prefix of the request identifier so click events can focus the
    /// right pane.
    pub session_id: Option<String>,
    /// Optional notification kind tag — `"done"` (completed/errored) or
    /// `"needs_input"` (waiting/permission). Embedded in the request
    /// identifier so [`crate::notifications::clear`] can selectively
    /// dismiss delivered notifications by `(session_id, kind)`.
    ///
    /// Only consumed by the macOS dispatch path (Linux's notify-rust
    /// flow has no notion of identifier-based dismissal); cfg-gate to
    /// avoid Linux's `dead_code` denial. Tests in this module call
    /// `build_request_identifier` directly with raw `Option<&str>`
    /// arguments — they don't construct `SendNotificationArgs` — so
    /// `cfg(test)` doesn't need to bring the field back on Linux.
    #[cfg(target_os = "macos")]
    pub kind: Option<String>,
    /// Optional parked permission-request id. When present *and* `kind`
    /// is `"needs_input"` the banner is delivered under
    /// [`PERMISSION_CATEGORY`], i.e. with Allow/Deny buttons, and the id
    /// is appended to the request identifier so the delegate can reply.
    ///
    /// Same cfg-gate rationale as `kind`: the Linux path has no action
    /// support, so the field would trip `dead_code` there.
    #[cfg(target_os = "macos")]
    pub request_id: Option<String>,
}

/// Result of [`notifications_send`].
#[derive(Debug, Serialize)]
pub struct SendNotificationResult {
    /// `true` when the OS reported the notification as accepted.
    /// `false` is informational only — callers do not retry.
    pub delivered: bool,
    /// Human-readable error string, populated when `delivered == false`.
    pub error: Option<String>,
}

/// Build the request identifier that round-trips `session_id`, `kind`
/// and (for permission prompts) `request_id` through the OS. Pure for
/// testing.
///
/// Format: `<session_id>\x1f<kind>\x1f<uuid>\x1f<request_id>`. Every
/// field but the uuid may be absent — when `kind` is `None`/empty we
/// fall back to the legacy two-part shape `<session_id>\x1f<uuid>` so
/// the click delegate (which only inspects the prefix) keeps working
/// unchanged. `request_id` is strictly appended, so
/// [`crate::notifications::clear`]'s `<session_id>\x1f<kind>\x1f` prefix
/// match is unaffected.
#[cfg(any(target_os = "macos", test))]
pub fn build_request_identifier(
    session_id: Option<&str>,
    kind: Option<&str>,
    request_id: Option<&str>,
) -> String {
    let suffix = uuid::Uuid::new_v4().to_string();
    let sid = session_id.unwrap_or("");
    let Some(kind) = kind.filter(|k| !k.is_empty()) else {
        // No kind ⇒ no request id either; a permission prompt always
        // carries `needs_input`.
        return format!("{sid}{IDENTIFIER_SEPARATOR}{suffix}");
    };
    let base = format!("{sid}{IDENTIFIER_SEPARATOR}{kind}{IDENTIFIER_SEPARATOR}{suffix}");
    match request_id.filter(|r| !r.is_empty()) {
        Some(rid) => format!("{base}{IDENTIFIER_SEPARATOR}{rid}"),
        None => base,
    }
}

/// Recover the `session_id` from a request identifier produced by
/// [`build_request_identifier`]. `None` when the identifier had no
/// session prefix.
#[cfg(any(target_os = "macos", test))]
pub fn session_id_from_identifier(identifier: &str) -> Option<String> {
    let (prefix, _) = identifier.split_once(IDENTIFIER_SEPARATOR)?;
    if prefix.is_empty() {
        None
    } else {
        Some(prefix.to_string())
    }
}

/// Recover the `kind` tag from a request identifier produced by
/// [`build_request_identifier`]. Returns `None` for legacy two-part
/// identifiers (no kind) and for any identifier that lacks a second
/// separator (defensive: pre-upgrade notifications still in the OS
/// queue must not panic).
///
/// Currently only exercised by tests — the production dismiss path in
/// [`crate::notifications::clear`] matches whole identifier prefixes
/// instead of parsing them — but the helper is the natural counterpart
/// to [`session_id_from_identifier`] and we want it covered so any future
/// caller that needs it doesn't reinvent the parser.
#[cfg(any(target_os = "macos", test))]
#[allow(dead_code)]
pub fn kind_from_identifier(identifier: &str) -> Option<String> {
    let (_, after_session) = identifier.split_once(IDENTIFIER_SEPARATOR)?;
    let (kind, _) = after_session.split_once(IDENTIFIER_SEPARATOR)?;
    if kind.is_empty() {
        None
    } else {
        Some(kind.to_string())
    }
}

/// Recover the parked `request_id` from a request identifier produced by
/// [`build_request_identifier`]. `None` for every identifier that isn't a
/// permission prompt (legacy two-part, plain three-part, or a stale
/// identifier minted before this field existed).
#[cfg(any(target_os = "macos", test))]
pub fn request_id_from_identifier(identifier: &str) -> Option<String> {
    identifier
        .split(IDENTIFIER_SEPARATOR)
        .nth(3)
        .filter(|r| !r.is_empty())
        .map(str::to_string)
}

/// §11 — send an OS notification via the modern, supported API on each
/// platform. Errors are returned as `Ok(SendNotificationResult)` with
/// `delivered: false` so the frontend dispatcher does not need to
/// distinguish "command failed" from "OS dropped it".
#[tauri::command]
pub async fn notifications_send<R: Runtime>(
    #[allow(unused_variables)] app: AppHandle<R>,
    args: SendNotificationArgs,
) -> Result<SendNotificationResult, String> {
    info!(
        title = %args.title,
        session_id = args.session_id.as_deref().unwrap_or("-"),
        "notifications_send: dispatching"
    );

    #[cfg(target_os = "macos")]
    {
        // Calling UNUserNotificationCenter from an unbundled binary
        // (`task dev`) throws `NSInternalInconsistencyException`. Skip
        // dispatch and report `delivered: false` so the frontend treats
        // it the same as a permission-denied or otherwise-dropped send.
        if !crate::notifications::is_bundled() {
            return Ok(SendNotificationResult {
                delivered: false,
                error: Some("unbundled process (dev mode)".to_string()),
            });
        }
        // Action buttons only make sense on a live permission prompt —
        // a `done` banner has nothing to allow or deny.
        let request_id = args
            .request_id
            .as_deref()
            .filter(|r| !r.is_empty())
            .filter(|_| args.kind.as_deref() == Some(NEEDS_INPUT_KIND));
        let identifier =
            build_request_identifier(args.session_id.as_deref(), args.kind.as_deref(), request_id);
        return Ok(send_macos(&args, &identifier, request_id.is_some()).await);
    }

    #[cfg(target_os = "linux")]
    {
        return Ok(send_linux(&args).await);
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        warn!("notifications_send: no platform implementation");
        Ok(SendNotificationResult {
            delivered: false,
            error: Some("unsupported platform".to_string()),
        })
    }
}

#[cfg(target_os = "macos")]
async fn send_macos(
    args: &SendNotificationArgs,
    identifier: &str,
    with_actions: bool,
) -> SendNotificationResult {
    use std::time::Duration;

    use block2::RcBlock;
    use objc2_foundation::{NSError, NSString};
    use objc2_user_notifications::{
        UNMutableNotificationContent, UNNotificationRequest, UNUserNotificationCenter,
    };

    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();

    // All Objective-C objects (`Retained<NSString>`, `RcBlock`, …) are
    // `!Send` and `!Sync`. Tauri requires `#[command] async fn` futures to
    // be `Send`, which means none of these locals can live across an
    // `.await`. Scope every NS object inside this block — once the OS has
    // accepted the request, it has retained its own copies of the
    // identifier/content/completion handler, so dropping our locals is
    // safe.
    {
        let title_ns = NSString::from_str(&args.title);
        let body_ns = NSString::from_str(&args.body);
        let identifier_ns = NSString::from_str(identifier);

        // The objc2-user-notifications 0.3 bindings expose these constructors
        // and setters as safe Rust — Objective-C reference counting is handled
        // by `Retained<T>`, and the methods do not require any caller-supplied
        // unchecked invariants. The completion-handler `*mut NSError`
        // dereference is the one piece that needs an `unsafe` block.
        let content = UNMutableNotificationContent::new();
        content.setTitle(&title_ns);
        content.setBody(&body_ns);
        if with_actions {
            // The category (and its Allow/Deny actions) is registered once
            // by `delegate::install`; here we only tag the notification
            // with it. macOS surfaces the buttons on hover/expand, or
            // immediately when the user has raum set to "Alerts".
            content.setCategoryIdentifier(&NSString::from_str(PERMISSION_CATEGORY));
        }

        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &identifier_ns,
            &content,
            None,
        );

        let center = UNUserNotificationCenter::currentNotificationCenter();

        let tx_cell = std::sync::Mutex::new(Some(tx));
        let completion = RcBlock::new(move |error: *mut NSError| {
            let err_msg: Option<String> = if error.is_null() {
                None
            } else {
                #[allow(unsafe_code)]
                let err_ref: &NSError = unsafe { &*error };
                Some(err_ref.localizedDescription().to_string())
            };
            if let Ok(mut guard) = tx_cell.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(err_msg);
                }
            }
        });

        center.addNotificationRequest_withCompletionHandler(&request, Some(&completion));
    }

    match tokio::time::timeout(Duration::from_secs(2), rx).await {
        Ok(Ok(None)) => {
            info!(identifier, "notifications_send: macOS delivered");
            SendNotificationResult {
                delivered: true,
                error: None,
            }
        }
        Ok(Ok(Some(msg))) => {
            warn!(identifier, error = %msg, "notifications_send: macOS rejected");
            SendNotificationResult {
                delivered: false,
                error: Some(msg),
            }
        }
        Ok(Err(_)) => {
            warn!(identifier, "notifications_send: completion handler dropped");
            SendNotificationResult {
                delivered: false,
                error: Some("completion handler dropped".to_string()),
            }
        }
        Err(_) => {
            warn!(identifier, "notifications_send: timed out after 2s");
            SendNotificationResult {
                delivered: false,
                error: Some("notification add timed out".to_string()),
            }
        }
    }
}

#[cfg(target_os = "linux")]
async fn send_linux(args: &SendNotificationArgs) -> SendNotificationResult {
    let title = args.title.clone();
    let body = args.body.clone();
    let res = tokio::task::spawn_blocking(move || {
        notify_rust::Notification::new()
            .summary(&title)
            .body(&body)
            .show()
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await;

    match res {
        Ok(Ok(())) => {
            info!("notifications_send: Linux delivered");
            SendNotificationResult {
                delivered: true,
                error: None,
            }
        }
        Ok(Err(e)) => {
            warn!(error = %e, "notifications_send: Linux notify-rust failed");
            SendNotificationResult {
                delivered: false,
                error: Some(e),
            }
        }
        Err(e) => {
            warn!(error = %e, "notifications_send: Linux spawn_blocking failed");
            SendNotificationResult {
                delivered: false,
                error: Some(e.to_string()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_session_id_through_identifier() {
        let id = build_request_identifier(Some("sess-abc"), None, None);
        assert!(id.starts_with("sess-abc"));
        assert!(id.contains(IDENTIFIER_SEPARATOR));
        assert_eq!(session_id_from_identifier(&id).as_deref(), Some("sess-abc"));
    }

    #[test]
    fn handles_missing_session_id() {
        let id = build_request_identifier(None, None, None);
        assert!(id.starts_with(IDENTIFIER_SEPARATOR));
        assert!(session_id_from_identifier(&id).is_none());
    }

    #[test]
    fn rejects_empty_session_id_prefix() {
        let id = build_request_identifier(Some(""), None, None);
        assert!(session_id_from_identifier(&id).is_none());
    }

    #[test]
    fn unrecognised_identifier_returns_none() {
        assert!(session_id_from_identifier("plain-uuid-no-separator").is_none());
    }

    #[test]
    fn round_trips_kind_through_identifier() {
        let id = build_request_identifier(Some("sess-abc"), Some("done"), None);
        assert_eq!(session_id_from_identifier(&id).as_deref(), Some("sess-abc"));
        assert_eq!(kind_from_identifier(&id).as_deref(), Some("done"));
    }

    #[test]
    fn round_trips_kind_without_session() {
        let id = build_request_identifier(None, Some(NEEDS_INPUT_KIND), None);
        assert!(session_id_from_identifier(&id).is_none());
        assert_eq!(kind_from_identifier(&id).as_deref(), Some(NEEDS_INPUT_KIND));
    }

    #[test]
    fn legacy_two_part_identifier_yields_no_kind() {
        // Identifiers minted before this change carry only the session id —
        // a single \x1f separator. The parser must not panic and must report
        // `kind = None`.
        let legacy = build_request_identifier(Some("sess-legacy"), None, None);
        assert_eq!(
            session_id_from_identifier(&legacy).as_deref(),
            Some("sess-legacy")
        );
        assert!(kind_from_identifier(&legacy).is_none());
    }

    #[test]
    fn unrecognised_identifier_yields_no_kind() {
        assert!(kind_from_identifier("plain-uuid-no-separator").is_none());
    }

    #[test]
    fn round_trips_request_id_through_identifier() {
        let id = build_request_identifier(Some("sess-abc"), Some(NEEDS_INPUT_KIND), Some("req-9"));
        assert_eq!(session_id_from_identifier(&id).as_deref(), Some("sess-abc"));
        assert_eq!(kind_from_identifier(&id).as_deref(), Some(NEEDS_INPUT_KIND));
        assert_eq!(request_id_from_identifier(&id).as_deref(), Some("req-9"));
    }

    #[test]
    fn identifiers_without_request_id_yield_none() {
        for id in [
            build_request_identifier(Some("s"), Some("done"), None),
            build_request_identifier(Some("s"), None, None),
            build_request_identifier(Some("s"), Some(NEEDS_INPUT_KIND), Some("")),
            "plain-uuid-no-separator".to_string(),
        ] {
            assert!(request_id_from_identifier(&id).is_none(), "{id:?}");
        }
    }

    #[test]
    fn request_id_is_appended_after_the_clear_prefix() {
        // `notifications::clear` dismisses by the `<session>\x1f<kind>\x1f`
        // prefix. Appending the request id must not disturb that, otherwise
        // answered permission banners would linger in Notification Center.
        let prefix =
            format!("sess-1{IDENTIFIER_SEPARATOR}{NEEDS_INPUT_KIND}{IDENTIFIER_SEPARATOR}");
        let with_req =
            build_request_identifier(Some("sess-1"), Some(NEEDS_INPUT_KIND), Some("req-1"));
        let without = build_request_identifier(Some("sess-1"), Some(NEEDS_INPUT_KIND), None);
        assert!(with_req.starts_with(&prefix));
        assert!(without.starts_with(&prefix));
    }
}
