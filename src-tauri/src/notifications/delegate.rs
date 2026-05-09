//! §11 — `UNUserNotificationCenterDelegate` for click-to-focus.
//!
//! macOS only delivers two pieces of UX through the delegate:
//!
//! 1. **`willPresentNotification`** — fires when a notification arrives
//!    while raum is foregrounded. By default the OS suppresses the banner
//!    in that case; we override to keep banners visible regardless of
//!    focus state. The user explicitly asked for "always system, even
//!    when focused".
//! 2. **`didReceiveNotificationResponse`** — fires when the user clicks
//!    the banner or a Notification Center entry. We extract the
//!    originating session id from the request identifier (encoded by
//!    [`super::send::build_request_identifier`]), emit a Tauri event
//!    `notifications:clicked` with `{ sessionId }`, and bring the main
//!    window forward so the pane comes into view.
//!
//! The delegate must be installed BEFORE the first notification is
//! delivered. Critically, macOS will relaunch the app and redeliver the
//! click response if the user clicks while raum is not running — but only
//! when the delegate is registered early in startup (the `.setup`
//! closure).

use std::sync::OnceLock;

use block2::Block;
use objc2::define_class;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_foundation::{NSObject, NSObjectProtocol};
use objc2_user_notifications::{
    UNNotification, UNNotificationPresentationOptions, UNNotificationResponse,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::{AppHandle, Emitter, Wry};
use tracing::{info, warn};

use crate::notifications::send::session_id_from_identifier;

/// Stash of the live `AppHandle`. Set once during `.setup` and read
/// from delegate callbacks. The delegate methods are invoked by macOS on
/// arbitrary threads, so we cannot pass the handle as an ivar without
/// jumping through `Send + Sync` hoops; a process-global `OnceLock` is
/// simpler and there is only ever one delegate.
static APP_HANDLE: OnceLock<AppHandle<Wry>> = OnceLock::new();

/// Capture the live `AppHandle` for use from delegate callbacks. Idempotent
/// — subsequent calls are no-ops.
pub fn set_app_handle(handle: AppHandle<Wry>) {
    let _ = APP_HANDLE.set(handle);
}

define_class!(
    /// Custom Objective-C class implementing `UNUserNotificationCenterDelegate`.
    /// One instance is allocated during `.setup` and retained on
    /// `AppHandleState` so it lives for the app's lifetime.
    #[unsafe(super(NSObject))]
    #[name = "RaumNotificationDelegate"]
    #[derive(Debug)]
    pub struct RaumNotificationDelegate;

    unsafe impl NSObjectProtocol for RaumNotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for RaumNotificationDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &Block<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            let options = UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::Sound
                | UNNotificationPresentationOptions::List;
            completion.call((options,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &Block<dyn Fn()>,
        ) {
            handle_click(response);
            completion.call(());
        }
    }
);

impl RaumNotificationDelegate {
    /// Allocate a new delegate. Safe because `RaumNotificationDelegate`
    /// stores no Rust state — all interaction goes through the static
    /// `APP_HANDLE`.
    pub fn new() -> Retained<Self> {
        let this = Self::alloc();
        // SAFETY: `init` is a standard Objective-C designated initialiser
        // that takes no arguments; `alloc().init()` is the canonical
        // construction pattern. The bindings expose `init` as unsafe.
        #[allow(unsafe_code)]
        unsafe {
            objc2::msg_send![this, init]
        }
    }
}

/// Install the delegate on the shared `UNUserNotificationCenter`. The
/// delegate must be retained somewhere (return value) for the lifetime of
/// the app, otherwise Objective-C will deallocate it and the OS will
/// silently stop delivering callbacks.
pub fn install(handle: AppHandle<Wry>) -> Retained<RaumNotificationDelegate> {
    set_app_handle(handle);
    let delegate = RaumNotificationDelegate::new();
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let proto: &ProtocolObject<dyn UNUserNotificationCenterDelegate> =
        ProtocolObject::from_ref(&*delegate);
    center.setDelegate(Some(proto));
    info!("notifications::delegate: installed UNUserNotificationCenter delegate");
    delegate
}

fn handle_click(response: &UNNotificationResponse) {
    let identifier_ns = response.notification().request().identifier();
    let identifier = identifier_ns.to_string();
    let session_id = session_id_from_identifier(&identifier);

    info!(
        identifier,
        session_id = session_id.as_deref().unwrap_or("-"),
        "notifications::delegate: click received"
    );

    let Some(app) = APP_HANDLE.get() else {
        warn!("notifications::delegate: APP_HANDLE not set on click");
        return;
    };

    let payload = serde_json::json!({ "sessionId": session_id });
    if let Err(e) = app.emit("notifications:clicked", payload) {
        warn!(error = %e, "notifications:clicked emit failed");
    }

    let app_for_thread = app.clone();
    // Window operations on macOS need the main thread.
    let _ = app.run_on_main_thread(move || {
        // SAFETY: `run_on_main_thread` guarantees we run on the main
        // thread, so a `MainThreadMarker` is sound here. We don't actually
        // need it for `focus_window`, but the comment above documents the
        // invariant for any future caller that does.
        #[allow(unsafe_code)]
        let _mtm = unsafe { MainThreadMarker::new_unchecked() };
        crate::notifications::focus_window(&app_for_thread);
    });
}
