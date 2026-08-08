//! §11 — `UNUserNotificationCenterDelegate` for click-to-focus.
//!
//! macOS only delivers two pieces of UX through the delegate:
//!
//! 1. **`willPresentNotification`** — fires when a notification arrives
//!    while raum is foregrounded. By default the OS suppresses the banner
//!    in that case; we override so the banner always shows. Focus gating
//!    lives one layer up — `notificationCenter.ts` doesn't call
//!    `notifications_send` at all while raum has focus, since the in-app
//!    Attention rail already covers it — so in practice everything that
//!    reaches this callback was sent from the background.
//! 2. **`didReceiveNotificationResponse`** — fires when the user clicks
//!    the banner, a Notification Center entry, or one of our action
//!    buttons. We extract the originating session id from the request
//!    identifier (encoded by [`super::send::build_request_identifier`]).
//!    A plain click emits the Tauri event `notifications:clicked` with
//!    `{ sessionId }` and brings the main window forward so the pane
//!    comes into view; an Allow/Deny button instead replies to the
//!    parked permission request and deliberately does *not* focus the
//!    window — both actions are background actions, so answering a
//!    prompt never yanks the user out of whatever they were doing.
//!
//! [`install`] also registers the `raum.permission` category that
//! carries those two actions. Categories must exist before any
//! notification referencing them is delivered, which the `.setup`-time
//! install site already guarantees.
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
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSSet, NSString};
use objc2_user_notifications::{
    UNNotification, UNNotificationAction, UNNotificationActionOptions, UNNotificationCategory,
    UNNotificationCategoryOptions, UNNotificationPresentationOptions, UNNotificationResponse,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use raum_core::harness::Decision;
use tauri::{AppHandle, Emitter, Wry};
use tracing::{info, warn};

use crate::notifications::send::{
    ALLOW_ACTION, DENY_ACTION, PERMISSION_CATEGORY, request_id_from_identifier,
    session_id_from_identifier,
};

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
            handle_response(response);
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
    register_permission_category(&center);
    info!("notifications::delegate: installed UNUserNotificationCenter delegate");
    delegate
}

/// Register the `raum.permission` category so permission banners can
/// carry Allow/Deny buttons.
///
/// Both actions are *background* actions (no `Foreground` option) — the
/// user answers without raum stealing focus. Deny is marked
/// `Destructive` so macOS styles it in red. `setNotificationCategories`
/// replaces the whole set, which is fine: this is raum's only category.
fn register_permission_category(center: &UNUserNotificationCenter) {
    let allow = UNNotificationAction::actionWithIdentifier_title_options(
        &NSString::from_str(ALLOW_ACTION),
        &NSString::from_str("Allow"),
        UNNotificationActionOptions::empty(),
    );
    let deny = UNNotificationAction::actionWithIdentifier_title_options(
        &NSString::from_str(DENY_ACTION),
        &NSString::from_str("Deny"),
        UNNotificationActionOptions::Destructive,
    );

    let actions = NSArray::from_slice(&[&*allow, &*deny]);
    let no_intents: &[&NSString] = &[];
    let category = UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
        &NSString::from_str(PERMISSION_CATEGORY),
        &actions,
        &NSArray::from_slice(no_intents),
        UNNotificationCategoryOptions::empty(),
    );

    center.setNotificationCategories(&NSSet::from_slice(&[&*category]));
}

/// Route a notification response: our own action ids answer the parked
/// permission request, everything else (the default body click, and any
/// identifier we don't recognise) keeps the historical focus behaviour.
fn handle_response(response: &UNNotificationResponse) {
    let identifier = response.notification().request().identifier().to_string();
    match response.actionIdentifier().to_string().as_str() {
        ALLOW_ACTION => reply_from_action(&identifier, Decision::Allow),
        DENY_ACTION => reply_from_action(&identifier, Decision::Deny),
        _ => handle_click(&identifier),
    }
}

/// Answer a parked permission request from an OS action button.
///
/// Fire-and-forget onto the Tauri async runtime: the delegate callback
/// must return promptly so macOS can invoke its completion handler.
/// Duplicate taps are benign — `deliver_permission_decision` reports
/// `Ok(false)` once the request is no longer parked.
fn reply_from_action(identifier: &str, decision: Decision) {
    let Some(request_id) = request_id_from_identifier(identifier) else {
        warn!(
            identifier,
            "notifications::delegate: action on a notification with no request id"
        );
        return;
    };
    let session_id = session_id_from_identifier(identifier);

    let Some(app) = APP_HANDLE.get() else {
        warn!("notifications::delegate: APP_HANDLE not set on action");
        return;
    };
    let app = app.clone();

    tauri::async_runtime::spawn(async move {
        let result = crate::commands::permission::deliver_permission_decision(
            &app,
            session_id.as_deref(),
            &request_id,
            decision,
        )
        .await;
        match result {
            Ok(delivered) => info!(
                request_id,
                delivered,
                decision = %decision.wire_tag(),
                "notifications::delegate: permission action dispatched"
            ),
            Err(e) => warn!(
                error = %e,
                request_id,
                "notifications::delegate: permission action failed"
            ),
        }
    });
}

fn handle_click(identifier: &str) {
    let session_id = session_id_from_identifier(identifier);

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
