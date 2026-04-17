//! OpenCode HTTP-reply replier (Phase 4, per-harness notification plan).
//!
//! Answers an OpenCode permission request by POSTing to
//! `/permission/:requestID/reply` on the local OpenCode server. The
//! actual path and body shape were confirmed against
//! `packages/opencode/src/server/routes/instance/permission.ts`
//! (body is `{ reply: "once" | "always" | "reject", message?: string }`,
//! NOT `{ response, remember? }` as the plan sketch assumed).
//!
//! The replier shares a [`PendingRequestMap`] with
//! [`super::opencode_sse::OpenCodeSseChannel`] so consumers can resolve a
//! request id back to its session id when rendering the notification
//! card. The POST itself does not require the session id, but logging /
//! tracing does.

use async_trait::async_trait;
use std::time::Duration;
use tracing::{debug, warn};

use crate::harness::event::PermissionRequestId;
use crate::harness::opencode_sse::PendingRequestMap;
use crate::harness::reply::{Decision, PermissionReplier, ReplyError, ReplyMode};

/// POST body shape. OpenCode accepts three `reply` values:
/// * `"once"` — allow this single invocation.
/// * `"always"` — allow and append a persistent rule.
/// * `"reject"` — deny with an optional message.
#[derive(serde::Serialize, Debug, Clone)]
struct ReplyBody<'a> {
    reply: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
}

/// HTTP replier for OpenCode.
#[allow(missing_debug_implementations)]
pub struct HttpReplyReplier {
    base_url: String,
    client: reqwest::Client,
    pending: PendingRequestMap,
}

impl HttpReplyReplier {
    #[must_use]
    pub fn new(base_url: impl Into<String>, pending: PendingRequestMap) -> Self {
        Self {
            base_url: base_url.into(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            pending,
        }
    }

    #[must_use]
    pub fn with_client(mut self, client: reqwest::Client) -> Self {
        self.client = client;
        self
    }

    #[must_use]
    pub fn base_url(&self) -> &str {
        &self.base_url
    }
}

/// Map raum's [`Decision`] variants onto OpenCode's `reply` string.
/// [`Decision::Ask`] has no OpenCode equivalent — it is the "bounce back
/// to the native TUI" escape hatch, so it maps to a transport-level
/// rejection rather than to a reply body.
fn decision_to_reply(d: Decision) -> Result<&'static str, ReplyError> {
    match d {
        Decision::Allow => Ok("once"),
        Decision::AllowAndRemember => Ok("always"),
        Decision::Deny => Ok("reject"),
        Decision::Ask => Err(ReplyError::Rejected(
            "OpenCode has no `ask` reply; the native TUI handles fallback".into(),
        )),
    }
}

#[async_trait]
impl PermissionReplier for HttpReplyReplier {
    async fn reply(
        &self,
        request_id: &PermissionRequestId,
        decision: Decision,
    ) -> Result<(), ReplyError> {
        let reply = decision_to_reply(decision)?;
        let body = ReplyBody {
            reply,
            message: None,
        };
        // Log the (optional) session id if we tracked one; helps when
        // correlating against OpenCode's logs during debugging.
        if let Some(session) = self.pending.lock().get(request_id).cloned() {
            debug!(
                target: "opencode_reply",
                request=%request_id.as_str(),
                session=%session.as_str(),
                reply,
                "POST /permission/:id/reply"
            );
        } else {
            debug!(
                target: "opencode_reply",
                request=%request_id.as_str(),
                reply,
                "POST /permission/:id/reply (session unknown)"
            );
        }

        let url = format!(
            "{}/permission/{}/reply",
            self.base_url.trim_end_matches('/'),
            request_id.as_str()
        );
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    ReplyError::Timeout
                } else {
                    ReplyError::Transport(format!("post {url}: {e}"))
                }
            })?;

        let status = resp.status();
        if status.as_u16() == 404 {
            // Clear the stale map entry; OpenCode has already forgotten
            // about this request (typically because it was answered in
            // the TUI between the notification firing and the user
            // clicking).
            self.pending.lock().remove(request_id);
            return Err(ReplyError::UnknownRequest(request_id.as_str().to_string()));
        }
        if !status.is_success() {
            warn!(
                target: "opencode_reply",
                status=%status,
                request=%request_id.as_str(),
                "non-2xx from OpenCode"
            );
            return Err(ReplyError::Rejected(format!(
                "OpenCode returned HTTP {status}"
            )));
        }
        // Clear the pending map entry on success so a stale replier
        // doesn't leak memory for long-lived sessions.
        self.pending.lock().remove(request_id);
        Ok(())
    }

    fn mode(&self) -> ReplyMode {
        ReplyMode::HttpReply
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::SessionId;
    use crate::harness::opencode_sse::new_pending_map;

    #[test]
    fn decision_allow_maps_to_once() {
        assert_eq!(decision_to_reply(Decision::Allow).unwrap(), "once");
        assert_eq!(
            decision_to_reply(Decision::AllowAndRemember).unwrap(),
            "always"
        );
        assert_eq!(decision_to_reply(Decision::Deny).unwrap(), "reject");
        assert!(matches!(
            decision_to_reply(Decision::Ask),
            Err(ReplyError::Rejected(_))
        ));
    }

    #[tokio::test]
    async fn replier_posts_correct_body_and_path() {
        use wiremock::matchers::{body_json, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/permission/perm-1/reply"))
            .and(body_json(serde_json::json!({ "reply": "once" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(true))
            .mount(&server)
            .await;

        let pending = new_pending_map();
        pending
            .lock()
            .insert(PermissionRequestId::new("perm-1"), SessionId::new("sess-1"));
        let replier = HttpReplyReplier::new(server.uri(), pending.clone());
        replier
            .reply(&PermissionRequestId::new("perm-1"), Decision::Allow)
            .await
            .expect("ok");
        // Success drops the entry from the pending map.
        assert!(
            pending
                .lock()
                .get(&PermissionRequestId::new("perm-1"))
                .is_none()
        );
    }

    #[tokio::test]
    async fn replier_allow_and_remember_maps_to_always() {
        use wiremock::matchers::{body_json, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/permission/perm-x/reply"))
            .and(body_json(serde_json::json!({ "reply": "always" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(true))
            .mount(&server)
            .await;
        let replier = HttpReplyReplier::new(server.uri(), new_pending_map());
        replier
            .reply(
                &PermissionRequestId::new("perm-x"),
                Decision::AllowAndRemember,
            )
            .await
            .expect("ok");
    }

    #[tokio::test]
    async fn replier_404_maps_to_unknown_request() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/permission/missing/reply"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let pending = new_pending_map();
        pending.lock().insert(
            PermissionRequestId::new("missing"),
            SessionId::new("sess-1"),
        );
        let replier = HttpReplyReplier::new(server.uri(), pending.clone());
        let err = replier
            .reply(&PermissionRequestId::new("missing"), Decision::Deny)
            .await
            .expect_err("should 404");
        assert!(matches!(err, ReplyError::UnknownRequest(_)));
        // 404 also clears the stale entry.
        assert!(
            pending
                .lock()
                .get(&PermissionRequestId::new("missing"))
                .is_none()
        );
    }

    #[tokio::test]
    async fn replier_5xx_maps_to_rejected() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/permission/perm-1/reply"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let replier = HttpReplyReplier::new(server.uri(), new_pending_map());
        let err = replier
            .reply(&PermissionRequestId::new("perm-1"), Decision::Allow)
            .await
            .expect_err("should fail");
        assert!(matches!(err, ReplyError::Rejected(_)));
    }

    #[tokio::test]
    async fn replier_ask_rejects_without_posting() {
        // No mock — if the replier POSTed we'd get a connection error
        // against a dead port.
        let replier = HttpReplyReplier::new("http://127.0.0.1:1", new_pending_map());
        let err = replier
            .reply(&PermissionRequestId::new("perm-1"), Decision::Ask)
            .await
            .expect_err("ask rejected");
        assert!(matches!(err, ReplyError::Rejected(_)));
    }
}
