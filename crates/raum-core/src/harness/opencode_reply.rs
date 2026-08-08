//! OpenCode HTTP-reply replier (Phase 4, per-harness notification plan).
//!
//! Answers an OpenCode permission request by POSTing to
//! `/permission/:requestID/reply` on the local OpenCode server. The
//! actual path and body shape were confirmed against
//! `packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts`
//! (body is `{ reply: "once" | "always" | "reject", message?: string }`,
//! NOT `{ response, remember? }` as the plan sketch assumed).
//!
//! Route audit (opencode dev @ fe82a1b, v1.18.15): this request-scoped
//! route is the **current, non-deprecated** one; the session-scoped
//! `POST /session/:sessionID/permissions/:permissionID` carries
//! `deprecated: true` in both source and the generated OpenAPI, and its
//! body has no `remember` field either (the docs table on
//! opencode.ai/docs/server is stale). No fallback to the session-scoped
//! route: a 404 here is ambiguous (route-missing on opencode < 1.14.30
//! vs. request-already-answered, which is the *common* case because one
//! reject cascades to every sibling request in the session), so a
//! fallback POST would mostly fire spurious replies at a deprecated
//! endpoint.
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
/// to the native TUI" escape hatch, so it maps to `None`: we send
/// nothing and leave the request pending for OpenCode's own prompt.
fn decision_to_reply(d: Decision) -> Option<&'static str> {
    match d {
        Decision::Allow => Some("once"),
        Decision::AllowAndRemember => Some("always"),
        Decision::Deny => Some("reject"),
        Decision::Ask => None,
    }
}

#[async_trait]
impl PermissionReplier for HttpReplyReplier {
    async fn reply(
        &self,
        request_id: &PermissionRequestId,
        decision: Decision,
    ) -> Result<(), ReplyError> {
        let Some(reply) = decision_to_reply(decision) else {
            // `Ask` = graceful degradation: don't answer, let OpenCode's
            // own TUI prompt the user.
            debug!(
                target: "opencode_reply",
                request=%request_id.as_str(),
                "ask: not replying, native TUI handles it"
            );
            return Ok(());
        };
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
            // Idempotency: OpenCode has already forgotten this request —
            // the user double-clicked, answered in the TUI, or a sibling
            // `reject`/`always` in the same session cascaded and resolved
            // it. Nothing left to deliver and nothing the user needs to
            // see, so clear the stale map entry and report success.
            debug!(
                target: "opencode_reply",
                request=%request_id.as_str(),
                "404: already answered, treating as delivered"
            );
            self.pending.lock().remove(request_id);
            return Ok(());
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
        assert_eq!(decision_to_reply(Decision::Allow), Some("once"));
        assert_eq!(
            decision_to_reply(Decision::AllowAndRemember),
            Some("always")
        );
        assert_eq!(decision_to_reply(Decision::Deny), Some("reject"));
        assert_eq!(decision_to_reply(Decision::Ask), None);
    }

    #[test]
    fn body_serialises_without_message() {
        let json = serde_json::to_value(ReplyBody {
            reply: "reject",
            message: None,
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "reply": "reject" }));
        let json = serde_json::to_value(ReplyBody {
            reply: "reject",
            message: Some("nope"),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "reply": "reject", "message": "nope" })
        );
    }

    #[tokio::test]
    async fn base_url_trailing_slash_does_not_double_up() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/permission/perm-1/reply"))
            .respond_with(ResponseTemplate::new(200).set_body_json(true))
            .mount(&server)
            .await;
        let replier = HttpReplyReplier::new(format!("{}/", server.uri()), new_pending_map());
        replier
            .reply(&PermissionRequestId::new("perm-1"), Decision::Allow)
            .await
            .expect("ok");
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
    async fn replier_404_is_idempotent_success() {
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
        // A duplicate click on an already-answered request must not
        // surface an error to the UI.
        replier
            .reply(&PermissionRequestId::new("missing"), Decision::Deny)
            .await
            .expect("404 is benign");
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
    async fn replier_ask_is_noop_without_posting() {
        // No mock — if the replier POSTed we'd get a connection error
        // against a dead port.
        let replier = HttpReplyReplier::new("http://127.0.0.1:1", new_pending_map());
        replier
            .reply(&PermissionRequestId::new("perm-1"), Decision::Ask)
            .await
            .expect("ask is a no-op");
    }
}
