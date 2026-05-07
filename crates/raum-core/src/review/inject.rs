//! Drive a running OpenCode TUI from outside via its HTTP control endpoints.
//!
//! OpenCode's interactive `opencode` command does not accept a positional
//! initial prompt, and the `--prompt` CLI flag only pre-fills the textbox
//! (does not auto-submit) on currently shipped versions. So when the
//! cross-harness review feature spawns an OpenCode reviewer with a brief,
//! we deliver the brief out-of-band over HTTP.
//!
//! The endpoints used here (`/tui/append-prompt`, `/tui/submit-prompt`)
//! are the documented IDE-integration path on the OpenCode local server
//! — see <https://opencode.ai/docs/server/>. raum already pins the
//! server to a known port via `--port` at launch (see
//! `harness::launch::harness_launch_command`).
//!
//! ## Subscriber race
//!
//! `POST /tui/append-prompt` calls `Bus.publish` on the server, which
//! re-emits via Node's `EventEmitter` (`GlobalBus.emit`). EventEmitter
//! has **no buffer** — if the TUI worker thread hasn't connected its
//! event subscription yet, the publish is dropped silently and the 200
//! OK response gives no hint of the loss.
//!
//! Empirically the TUI takes ~500 ms-2 s to wire its subscription after
//! the HTTP server binds. Our HTTP readiness probe returns the moment
//! the server is up, so the first publish very often falls into that
//! gap. We therefore **observe a side effect** (`/session?directory=cwd`
//! growing past its pre-launch baseline) and retry the publish until
//! the side effect appears or a generous deadline expires. This is
//! self-healing across any cold-start time.

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::time::{Instant, sleep};
use tracing::{debug, warn};

/// Per-request timeout for every HTTP call. Short on purpose — the
/// server is on `127.0.0.1`, so anything beyond this is a sign the TUI
/// is stalled and we should retry.
const REQUEST_TIMEOUT: Duration = Duration::from_millis(500);

/// Total budget for the whole inject sequence (HTTP-up wait + publish
/// retries). Cold-cache OpenCode boots can take a couple of seconds; 30 s
/// leaves ample headroom without hanging forever if something is wrong.
const TOTAL_BUDGET: Duration = Duration::from_secs(30);

/// Interval between HTTP-readiness probes.
const READY_POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Interval between observation polls after a publish, before deciding to
/// retry. Short enough that a successful publish exits the loop without
/// risking a duplicate submit on the next iteration.
const OBSERVE_POLL_INTERVAL: Duration = Duration::from_millis(150);

/// How long to wait for a side effect (new session) after each publish
/// before giving up on this attempt and republishing. ~1.5 s is enough
/// for OpenCode to create the session and reflect it in the
/// `/session` listing once the TUI has actually consumed the events.
const OBSERVE_WINDOW: Duration = Duration::from_millis(1500);

/// Wait for the OpenCode TUI on `port` to be ready, then submit `brief`
/// as the first prompt. Best-effort: every failure degrades gracefully
/// (the user is left with a usable interactive TUI they can prompt
/// themselves) and is logged via `warn!`.
///
/// `base_url` is parameterised so tests can point at a `wiremock::MockServer`
/// instead of `127.0.0.1`. Production callers pass `"http://127.0.0.1"`.
///
/// `cwd` is the worktree the TUI is running in — used to scope the
/// session-listing observation to "did *our* opencode receive the
/// brief?".
pub async fn inject_opencode_brief(base_url: &str, port: u16, cwd: &Path, brief: &str) {
    if brief.trim().is_empty() {
        return;
    }
    let cwd_str = match cwd.to_str() {
        Some(s) => s,
        None => {
            warn!("opencode inject: non-UTF8 cwd, skipping");
            return;
        }
    };
    let client = match reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build() {
        Ok(c) => c,
        Err(e) => {
            warn!(error = %e, "opencode reqwest client build failed");
            return;
        }
    };

    let deadline = Instant::now() + TOTAL_BUDGET;

    if !wait_for_http(&client, base_url, port, deadline).await {
        warn!(port, "opencode TUI did not become ready before timeout");
        return;
    }

    // Snapshot existing sessions for this cwd. The TUI may have
    // auto-continued a previous session, so we don't assume zero — we
    // wait for the count to *grow*, which signals our submit took
    // effect. (For a fresh worktree the baseline is 0; for a continued
    // one it's >=1 and our submit pushes it to baseline+1 by creating a
    // new session — OpenCode creates a new session on first submit
    // even mid-TUI when there's no active session.)
    let baseline = list_session_count(&client, base_url, port, cwd_str).await;
    debug!(port, baseline, "opencode session baseline recorded");

    let mut attempt = 0u32;
    while Instant::now() < deadline {
        attempt += 1;
        publish_brief(&client, base_url, port, brief).await;

        // Observe for OBSERVE_WINDOW. A successful publish surfaces as
        // a session count > baseline within ~200-500 ms once the TUI is
        // actually subscribed; if it never appears, the publish was
        // dropped (TUI not subscribed yet) and we republish.
        let observe_until = Instant::now() + OBSERVE_WINDOW;
        loop {
            sleep(OBSERVE_POLL_INTERVAL).await;
            let current = list_session_count(&client, base_url, port, cwd_str).await;
            if current > baseline {
                debug!(port, attempt, "opencode brief submitted (session created)");
                return;
            }
            if Instant::now() >= observe_until || Instant::now() >= deadline {
                break;
            }
        }
    }

    warn!(
        port,
        attempt, "opencode brief submission timed out; user can submit manually"
    );
}

/// Poll until `/session` answers (any status < 500) or the deadline
/// passes. Any non-5xx response proves the HTTP layer is up; the bus
/// subscription is verified separately by the caller.
async fn wait_for_http(
    client: &reqwest::Client,
    base_url: &str,
    port: u16,
    deadline: Instant,
) -> bool {
    let probe_url = format!("{base_url}:{port}/session");
    loop {
        if let Ok(resp) = client.get(&probe_url).query(&[("limit", "1")]).send().await
            && resp.status().as_u16() < 500
        {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        sleep(READY_POLL_INTERVAL).await;
    }
}

/// Fire one append-then-submit pair. Best-effort; logs and swallows
/// errors so the caller can keep retrying.
async fn publish_brief(client: &reqwest::Client, base_url: &str, port: u16, brief: &str) {
    let append_url = format!("{base_url}:{port}/tui/append-prompt");
    let body = json!({ "text": brief });
    match client.post(&append_url).json(&body).send().await {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => {
            warn!(port, status = %resp.status(), "opencode append-prompt non-success");
            return;
        }
        Err(e) => {
            warn!(port, error = %e, "opencode append-prompt request failed");
            return;
        }
    }

    let submit_url = format!("{base_url}:{port}/tui/submit-prompt");
    match client.post(&submit_url).send().await {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => {
            warn!(port, status = %resp.status(), "opencode submit-prompt non-success");
        }
        Err(e) => {
            warn!(port, error = %e, "opencode submit-prompt request failed");
        }
    }
}

/// Count sessions OpenCode reports for `cwd`. Returns 0 on any failure
/// — the caller treats that as "no growth observed yet".
async fn list_session_count(
    client: &reqwest::Client,
    base_url: &str,
    port: u16,
    cwd: &str,
) -> usize {
    let url = format!("{base_url}:{port}/session");
    let resp = match client
        .get(&url)
        .query(&[("directory", cwd), ("limit", "10")])
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return 0,
    };
    if !resp.status().is_success() {
        return 0;
    }
    match resp.json::<Vec<Value>>().await {
        Ok(arr) => arr.len(),
        Err(_) => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use wiremock::matchers::{body_json, method, path};
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

    fn split_base_port(uri: &str) -> (String, u16) {
        // wiremock's `uri()` returns `http://127.0.0.1:<port>`. Split it
        // into the form our caller passes (`base_url + ":" + port`).
        let last_colon = uri.rfind(':').expect("port separator");
        let port = uri[last_colon + 1..].parse::<u16>().expect("port");
        (uri[..last_colon].to_string(), port)
    }

    /// Responder that returns an empty array for the first `n` GETs and
    /// a singleton array thereafter — used to simulate "TUI subscriber
    /// finally wired up after retry".
    struct GrowAfter {
        threshold: usize,
        counter: Arc<AtomicUsize>,
    }
    impl Respond for GrowAfter {
        fn respond(&self, _: &Request) -> ResponseTemplate {
            let i = self.counter.fetch_add(1, Ordering::SeqCst);
            if i < self.threshold {
                ResponseTemplate::new(200).set_body_json(serde_json::json!([]))
            } else {
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!([{"id": "ses_1", "directory": "/x"}]))
            }
        }
    }

    #[tokio::test]
    async fn empty_brief_is_a_noop() {
        let server = MockServer::start().await;
        let (base, port) = split_base_port(&server.uri());
        tokio::time::timeout(
            Duration::from_secs(1),
            inject_opencode_brief(&base, port, &PathBuf::from("/x"), "   "),
        )
        .await
        .expect("should return immediately");
    }

    #[tokio::test]
    async fn happy_path_appends_then_submits_once() {
        let server = MockServer::start().await;
        // /session: one call for HTTP-readiness, one for baseline (=[]),
        // then one or more for observation. Use GrowAfter with
        // threshold=2 → readiness sees [], baseline sees [], first
        // observe sees the new session.
        Mock::given(method("GET"))
            .and(path("/session"))
            .respond_with(GrowAfter {
                threshold: 2,
                counter: Arc::new(AtomicUsize::new(0)),
            })
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/tui/append-prompt"))
            .and(body_json(serde_json::json!({"text": "review this"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!(true)))
            .expect(1..=3)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/tui/submit-prompt"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!(true)))
            .expect(1..=3)
            .mount(&server)
            .await;
        let (base, port) = split_base_port(&server.uri());
        inject_opencode_brief(&base, port, &PathBuf::from("/x"), "review this").await;
    }

    #[tokio::test]
    async fn retries_until_session_appears() {
        let server = MockServer::start().await;
        // /session: many empty responses, then a non-empty one — the
        // injector must keep republishing until it observes growth.
        // Iteration 1 spends ~10 polls in its observe window; threshold
        // 20 forces at least one retry before the responder flips.
        Mock::given(method("GET"))
            .and(path("/session"))
            .respond_with(GrowAfter {
                threshold: 20,
                counter: Arc::new(AtomicUsize::new(0)),
            })
            .mount(&server)
            .await;
        let append_count = Arc::new(AtomicUsize::new(0));
        let appends = append_count.clone();
        Mock::given(method("POST"))
            .and(path("/tui/append-prompt"))
            .respond_with(move |_: &Request| {
                appends.fetch_add(1, Ordering::SeqCst);
                ResponseTemplate::new(200).set_body_json(serde_json::json!(true))
            })
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/tui/submit-prompt"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!(true)))
            .mount(&server)
            .await;
        let (base, port) = split_base_port(&server.uri());
        inject_opencode_brief(&base, port, &PathBuf::from("/x"), "x").await;
        assert!(
            append_count.load(Ordering::SeqCst) >= 2,
            "should have retried at least once before session appeared",
        );
    }
}
