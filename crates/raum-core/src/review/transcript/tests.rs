use super::claude::{clean_claude_user_text, encode_cwd_for_claude};
use super::opencode::read_opencode_user_prompts;
use super::*;
use std::fs;
use std::thread::sleep;
use tempfile::tempdir;

/// Set up a fake `$HOME/.claude/projects/<encoded>/` with a single
/// jsonl and return (home, jsonl_path). Tests then write the jsonl
/// content they want to parse. Mirrors the production encoding —
/// both `/` and `.` collapse to `-`.
fn fake_claude_home(cwd: &str) -> (tempfile::TempDir, PathBuf) {
    let home = tempdir().unwrap();
    let encoded: String = cwd
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    let dir = home.path().join(".claude").join("projects").join(encoded);
    fs::create_dir_all(&dir).unwrap();
    let jsonl = dir.join("aaaa.jsonl");
    (home, jsonl)
}

#[test]
fn encodes_dotted_paths_with_dashes() {
    // Verified against a real installation: a worktree at
    // `/Users/x/repo/.raum/feat-cross-review` is stored under
    // `~/.claude/projects/-Users-x-repo--raum-feat-cross-review/`.
    // Without dot replacement, the lookup silently misses for every
    // worktree under a hidden directory.
    assert_eq!(
        encode_cwd_for_claude(Path::new("/Users/x/repo/.raum/feat-cross-review")).as_deref(),
        Some("-Users-x-repo--raum-feat-cross-review"),
    );
    assert_eq!(
        encode_cwd_for_claude(Path::new("/Users/x/Projekte/private/raum")).as_deref(),
        Some("-Users-x-Projekte-private-raum"),
    );
}

#[tokio::test]
async fn finds_claude_transcript_for_dotted_worktree_path() {
    // End-to-end: worktree path with a hidden segment must resolve to
    // the right `~/.claude/projects/` directory and parse the prompts.
    let cwd = "/Users/x/repo/.raum/feat";
    let (home, jsonl) = fake_claude_home(cwd);
    fs::write(
        &jsonl,
        r#"{"type":"user","message":{"role":"user","content":"the dotted path one"}}
"#,
    )
    .unwrap();
    let prompts =
        read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts, vec!["the dotted path one"]);
}

#[test]
fn discovers_newest_claude_jsonl() {
    let home = tempdir().unwrap();
    let cwd = Path::new("/Users/foo/myrepo");
    let proj_dir = home
        .path()
        .join(".claude")
        .join("projects")
        .join("-Users-foo-myrepo");
    fs::create_dir_all(&proj_dir).unwrap();

    let older = proj_dir.join("aaaa.jsonl");
    let newer = proj_dir.join("bbbb.jsonl");
    let unrelated = proj_dir.join("notes.txt");
    fs::write(&older, b"{}").unwrap();
    sleep(Duration::from_millis(50));
    fs::write(&newer, b"{}").unwrap();
    fs::write(&unrelated, b"hi").unwrap();

    let found = discover_transcript_path(AgentKind::ClaudeCode, cwd, home.path());
    assert_eq!(found.as_deref(), Some(newer.as_path()));
}

#[test]
fn discover_claude_session_id_uses_newest_jsonl_stem() {
    let home = tempdir().unwrap();
    let cwd = Path::new("/Users/foo/myrepo");
    let proj_dir = home
        .path()
        .join(".claude")
        .join("projects")
        .join("-Users-foo-myrepo");
    fs::create_dir_all(&proj_dir).unwrap();

    fs::write(proj_dir.join("older-session.jsonl"), b"{}").unwrap();
    sleep(Duration::from_millis(50));
    fs::write(proj_dir.join("newer-session.jsonl"), b"{}").unwrap();

    assert_eq!(
        discover_claude_session_id(cwd, home.path()).as_deref(),
        Some("newer-session")
    );
}

#[test]
fn discover_claude_session_id_by_prompt_disambiguates_shared_cwd() {
    let home = tempdir().unwrap();
    let cwd = Path::new("/Users/foo/myrepo");
    let proj_dir = home
        .path()
        .join(".claude")
        .join("projects")
        .join("-Users-foo-myrepo");
    fs::create_dir_all(&proj_dir).unwrap();

    fs::write(
        proj_dir.join("older-session.jsonl"),
        r#"{"type":"user","message":{"role":"user","content":"target prompt"}}
"#,
    )
    .unwrap();
    sleep(Duration::from_millis(50));
    fs::write(
        proj_dir.join("newer-sibling.jsonl"),
        r#"{"type":"user","message":{"role":"user","content":"different prompt"}}
"#,
    )
    .unwrap();

    assert_eq!(
        discover_claude_session_id(cwd, home.path()).as_deref(),
        Some("newer-sibling"),
    );
    assert_eq!(
        discover_session_id_by_prompt(AgentKind::ClaudeCode, cwd, home.path(), "target prompt")
            .as_deref(),
        Some("older-session"),
    );
}

#[tokio::test]
async fn missing_project_dir_returns_no_prompts() {
    let home = tempdir().unwrap();
    let cwd = Path::new("/never/seen/before");
    assert!(
        read_session_user_prompts(AgentKind::ClaudeCode, cwd, home.path(), None)
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn parses_string_content_user_prompts_in_order() {
    let cwd = "/Users/foo/repo";
    let (home, jsonl) = fake_claude_home(cwd);
    fs::write(
        &jsonl,
        r#"{"type":"user","message":{"role":"user","content":"first prompt"}}
{"type":"assistant","message":{"role":"assistant","content":"hi"}}
{"type":"user","message":{"role":"user","content":"second prompt"}}
"#,
    )
    .unwrap();
    let prompts =
        read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts, vec!["first prompt", "second prompt"]);
}

#[tokio::test]
async fn parses_text_block_array_content() {
    let cwd = "/Users/foo/repo";
    let (home, jsonl) = fake_claude_home(cwd);
    fs::write(
        &jsonl,
        r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi there"}]}}
"#,
    )
    .unwrap();
    let prompts =
        read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts, vec!["hi there"]);
}

#[tokio::test]
async fn skips_tool_result_entries() {
    let cwd = "/Users/foo/repo";
    let (home, jsonl) = fake_claude_home(cwd);
    fs::write(
        &jsonl,
        r#"{"type":"user","message":{"role":"user","content":"real one"}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"file bytes"}]}}
{"type":"user","message":{"role":"user","content":"another real"}}
"#,
    )
    .unwrap();
    let prompts =
        read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts, vec!["real one", "another real"]);
}

#[tokio::test]
async fn skips_pure_slash_command_machinery() {
    // Real-world: a session that starts with `/clear` records a
    // user-role entry whose content is nothing but slash-command
    // wrapper tags. That should NOT be treated as the first user
    // prompt — the next entry should win.
    let cwd = "/Users/foo/repo";
    let (home, jsonl) = fake_claude_home(cwd);
    fs::write(
        &jsonl,
        r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"}}
{"type":"user","message":{"role":"user","content":"the real first prompt"}}
"#,
    )
    .unwrap();
    let prompts =
        read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts, vec!["the real first prompt"]);
}

#[tokio::test]
async fn keeps_user_text_after_local_command_caveat() {
    // The `<local-command-caveat>...</local-command-caveat>` block
    // is injected ahead of a real user prompt after a slash
    // command runs. Strip the caveat, keep the prompt.
    let cwd = "/Users/foo/repo";
    let (home, jsonl) = fake_claude_home(cwd);
    fs::write(
        &jsonl,
        r#"{"type":"user","message":{"role":"user","content":"<local-command-caveat>Caveat: do not respond to these.</local-command-caveat>\nplease refactor the parser"}}
"#,
    )
    .unwrap();
    let prompts =
        read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts, vec!["please refactor the parser"]);
}

#[test]
fn clean_claude_user_text_strips_balanced_wrappers() {
    let stripped = clean_claude_user_text(
        "<command-name>/clear</command-name>\n<command-args></command-args>",
    );
    assert_eq!(stripped, None);

    let kept =
        clean_claude_user_text("<local-command-caveat>noise</local-command-caveat>\nactual prompt");
    assert_eq!(kept.as_deref(), Some("actual prompt"));

    let plain = clean_claude_user_text("just a normal prompt");
    assert_eq!(plain.as_deref(), Some("just a normal prompt"));
}

#[tokio::test]
async fn skips_blank_and_malformed_lines() {
    let cwd = "/Users/foo/repo";
    let (home, jsonl) = fake_claude_home(cwd);
    fs::write(
        &jsonl,
        "\n  \n{\"type\":\"user\",\"message\":{\"content\":\"good\"}}\nNOT JSON\n{\"type\":\"user\",\"message\":{\"content\":\"\"}}\n",
    )
    .unwrap();
    let prompts =
        read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts, vec!["good"]);
}

#[tokio::test]
async fn caps_at_max_returned() {
    use std::fmt::Write as _;
    let cwd = "/Users/foo/repo";
    let (home, jsonl) = fake_claude_home(cwd);
    let total = MAX_USER_PROMPTS_RETURNED + 7;
    let mut content = String::new();
    for i in 0..total {
        let _ = writeln!(
            content,
            "{{\"type\":\"user\",\"message\":{{\"content\":\"p{i}\"}}}}",
        );
    }
    fs::write(&jsonl, content).unwrap();
    let prompts =
        read_session_user_prompts(AgentKind::ClaudeCode, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts.len(), MAX_USER_PROMPTS_RETURNED);
    assert_eq!(prompts[0], "p7");
    assert_eq!(prompts.last().unwrap(), &format!("p{}", total - 1));
}

#[tokio::test]
async fn shell_returns_empty() {
    let home = tempdir().unwrap();
    let cwd = Path::new("/anywhere");
    assert!(
        read_session_user_prompts(AgentKind::Shell, cwd, home.path(), None)
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn opencode_without_port_returns_empty() {
    let home = tempdir().unwrap();
    let cwd = Path::new("/anywhere");
    assert!(
        read_session_user_prompts(AgentKind::OpenCode, cwd, home.path(), None)
            .await
            .is_empty()
    );
}

// ---- OpenCode HTTP tests (wiremock) ---------------------------------

#[tokio::test]
async fn opencode_http_extracts_user_prompts_in_order() {
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    let cwd = "/Users/foo/repo";

    // First call: GET /session?directory=...&limit=1
    Mock::given(method("GET"))
        .and(path("/session"))
        .and(query_param("directory", cwd))
        .and(query_param("limit", "1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            { "id": "ses_abc", "directory": cwd, "title": "demo" }
        ])))
        .mount(&server)
        .await;

    // Second call: GET /session/ses_abc/message
    Mock::given(method("GET"))
        .and(path("/session/ses_abc/message"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            {
                "info": { "role": "user", "time": { "created": 1 } },
                "parts": [
                    { "type": "text", "text": "first prompt", "synthetic": false }
                ]
            },
            {
                "info": { "role": "assistant", "time": { "created": 2 } },
                "parts": [{ "type": "text", "text": "an answer" }]
            },
            {
                "info": { "role": "user", "time": { "created": 3 } },
                "parts": [
                    { "type": "text", "text": "context", "synthetic": true },
                    { "type": "text", "text": "follow-up" }
                ]
            }
        ])))
        .mount(&server)
        .await;

    // Wiremock binds on a random port and returns "http://127.0.0.1:<port>".
    // Split that into the base + port that our function takes separately.
    let url = server.uri();
    let (base, port) = parse_wiremock_uri(&url);

    let prompts = read_opencode_user_prompts(&base, port, Path::new(cwd)).await;
    assert_eq!(prompts, vec!["first prompt", "follow-up"]);
}

#[tokio::test]
async fn opencode_http_no_session_for_cwd_returns_empty() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/session"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
        .mount(&server)
        .await;

    let (base, port) = parse_wiremock_uri(&server.uri());
    let prompts = read_opencode_user_prompts(&base, port, Path::new("/Users/x/repo")).await;
    assert!(prompts.is_empty());
}

#[tokio::test]
async fn opencode_http_skips_synthetic_only_messages() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/session"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([{ "id": "s1" }])))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/session/s1/message"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
            {
                "info": { "role": "user" },
                "parts": [{ "type": "text", "text": "synthetic only", "synthetic": true }]
            },
            {
                "info": { "role": "user" },
                "parts": [{ "type": "text", "text": "real" }]
            }
        ])))
        .mount(&server)
        .await;

    let (base, port) = parse_wiremock_uri(&server.uri());
    let prompts = read_opencode_user_prompts(&base, port, Path::new("/anywhere")).await;
    assert_eq!(prompts, vec!["real"]);
}

#[tokio::test]
async fn opencode_unreachable_server_returns_empty() {
    // Localhost port that's almost certainly closed. The 500 ms
    // timeout caps how long we block.
    let prompts = read_opencode_user_prompts("http://127.0.0.1", 1, Path::new("/anywhere")).await;
    assert!(prompts.is_empty());
}

#[test]
fn opencode_cli_session_list_picks_newest_matching_directory() {
    let cwd = Path::new("/Users/foo/repo");
    let raw = serde_json::json!([
        {
            "id": "ses_old",
            "directory": "/Users/foo/repo",
            "time": { "updated": 10 }
        },
        {
            "id": "ses_other",
            "directory": "/Users/foo/other",
            "time": { "updated": 999 }
        },
        {
            "id": "ses_new",
            "directory": "/Users/foo/repo",
            "time": { "updated": 20 }
        }
    ])
    .to_string();

    let got = super::opencode::session_id_for_directory_from_list_json(&raw, cwd);
    assert_eq!(got.as_deref(), Some("ses_new"));
}

#[test]
fn opencode_cli_session_list_accepts_project_directory_shape() {
    let cwd = Path::new("/Users/foo/repo");
    let raw = serde_json::json!([
        {
            "id": "ses_nested",
            "project": { "directory": "/Users/foo/repo" },
            "time": { "created": 1 }
        }
    ])
    .to_string();

    let got = super::opencode::session_id_for_directory_from_list_json(&raw, cwd);
    assert_eq!(got.as_deref(), Some("ses_nested"));
}

#[test]
fn opencode_cli_session_list_returns_none_for_invalid_json() {
    let got =
        super::opencode::session_id_for_directory_from_list_json("not-json", Path::new("/repo"));
    assert!(got.is_none());
}

/// Pull `("http://host", port)` out of a `http://127.0.0.1:NNNN` uri
/// — wiremock doesn't expose port directly. Helper for the OpenCode
/// HTTP tests.
fn parse_wiremock_uri(uri: &str) -> (String, u16) {
    let stripped = uri.strip_prefix("http://").unwrap();
    let (host, port) = stripped.split_once(':').unwrap();
    (format!("http://{host}"), port.parse().unwrap())
}

/// Set up a fake `$HOME/.codex/sessions/2026/04/29/rollout-test.jsonl`
/// with the given content + session_meta cwd. Returns (home, jsonl).
fn fake_codex_rollout(cwd: &str, content: &str) -> (tempfile::TempDir, PathBuf) {
    let home = tempdir().unwrap();
    let dir = home
        .path()
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("04")
        .join("29");
    fs::create_dir_all(&dir).unwrap();
    let jsonl = dir.join("rollout-abcd.jsonl");
    let session_meta = format!(
        "{{\"timestamp\":\"2026-04-29T12:00:00Z\",\"type\":\"session_meta\",\"payload\":{{\"id\":\"abcd\",\"cwd\":\"{cwd}\"}}}}\n"
    );
    let body = format!("{session_meta}{content}");
    fs::write(&jsonl, body).unwrap();
    (home, jsonl)
}

#[tokio::test]
async fn codex_response_item_message_user_role_is_extracted() {
    let cwd = "/Users/foo/repo";
    let (home, _jsonl) = fake_codex_rollout(
        cwd,
        "{\"timestamp\":\"...\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"first task\"}]}}\n\
{\"timestamp\":\"...\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}}\n\
{\"timestamp\":\"...\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"follow-up\"}]}}\n",
    );
    let prompts =
        read_session_user_prompts(AgentKind::Codex, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts, vec!["first task", "follow-up"]);
}

#[tokio::test]
async fn codex_legacy_user_message_event_is_extracted() {
    let cwd = "/Users/foo/repo";
    let (home, _) = fake_codex_rollout(
        cwd,
        "{\"timestamp\":\"...\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"hello\"}}\n",
    );
    let prompts =
        read_session_user_prompts(AgentKind::Codex, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts, vec!["hello"]);
}

#[tokio::test]
async fn codex_picks_newest_matching_cwd() {
    let cwd = "/Users/foo/repo";
    let home = tempdir().unwrap();
    let dir = home
        .path()
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("04")
        .join("29");
    fs::create_dir_all(&dir).unwrap();

    // Older rollout for our cwd.
    let older = dir.join("rollout-aaaa.jsonl");
    fs::write(
        &older,
        format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"{cwd}\"}}}}\n\
{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"old\"}}]}}}}\n",
        ),
    )
    .unwrap();
    sleep(Duration::from_millis(50));

    // Rollout for a *different* cwd — must be ignored even though it's newer.
    let other = dir.join("rollout-bbbb.jsonl");
    fs::write(
        &other,
        "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/elsewhere\"}}\n\
{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"unrelated\"}]}}\n",
    )
    .unwrap();
    sleep(Duration::from_millis(50));

    // Newer rollout for our cwd — wins.
    let newer = dir.join("rollout-cccc.jsonl");
    fs::write(
        &newer,
        format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"{cwd}\"}}}}\n\
{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"new\"}}]}}}}\n",
        ),
    )
    .unwrap();

    let prompts =
        read_session_user_prompts(AgentKind::Codex, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts, vec!["new"]);
}

#[test]
fn codex_session_id_discovery_reads_newest_matching_rollout_meta() {
    let cwd = "/Users/foo/repo";
    let home = tempdir().unwrap();
    let dir = home
        .path()
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("04")
        .join("29");
    fs::create_dir_all(&dir).unwrap();

    let older = dir.join("rollout-2026-04-29T10-00-00-old-id.jsonl");
    fs::write(
        &older,
        format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"old-id\",\"cwd\":\"{cwd}\"}}}}\n"
        ),
    )
    .unwrap();
    sleep(Duration::from_millis(50));

    let other = dir.join("rollout-2026-04-29T11-00-00-other-id.jsonl");
    fs::write(
        &other,
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"other-id\",\"cwd\":\"/elsewhere\"}}\n",
    )
    .unwrap();
    sleep(Duration::from_millis(50));

    let newer = dir.join("rollout-2026-04-29T12-00-00-new-id.jsonl");
    fs::write(
        &newer,
        format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"new-id\",\"cwd\":\"{cwd}\"}}}}\n"
        ),
    )
    .unwrap();

    assert_eq!(
        discover_codex_session_id(Path::new(cwd), home.path()).as_deref(),
        Some("new-id"),
    );
}

#[test]
fn codex_session_id_discovery_falls_back_to_uuid_filename_suffix() {
    let cwd = "/Users/foo/repo";
    let home = tempdir().unwrap();
    let dir = home
        .path()
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("04")
        .join("29");
    fs::create_dir_all(&dir).unwrap();

    let id = "123e4567-e89b-12d3-a456-426614174000";
    let rollout = dir.join(format!("rollout-2026-04-29T12-00-00-{id}.jsonl"));
    fs::write(
        &rollout,
        format!("{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"{cwd}\"}}}}\n"),
    )
    .unwrap();

    assert_eq!(
        discover_codex_session_id(Path::new(cwd), home.path()).as_deref(),
        Some(id),
    );
}

#[test]
fn discover_codex_session_id_by_prompt_disambiguates_shared_cwd() {
    let cwd = "/Users/foo/repo";
    let home = tempdir().unwrap();
    let dir = home
        .path()
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("04")
        .join("29");
    fs::create_dir_all(&dir).unwrap();

    let older_id = "11111111-1111-1111-1111-111111111111";
    let older = dir.join(format!("rollout-2026-04-29T10-00-00-{older_id}.jsonl"));
    fs::write(
        &older,
        format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"{cwd}\"}}}}\n\
{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"target prompt\"}}}}\n"
        ),
    )
    .unwrap();
    sleep(Duration::from_millis(50));

    let newer_id = "22222222-2222-2222-2222-222222222222";
    let newer = dir.join(format!("rollout-2026-04-29T11-00-00-{newer_id}.jsonl"));
    fs::write(
        &newer,
        format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"{cwd}\"}}}}\n\
{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"different prompt\"}}}}\n"
        ),
    )
    .unwrap();

    assert_eq!(
        discover_codex_session_id(Path::new(cwd), home.path()).as_deref(),
        Some(newer_id),
    );
    assert_eq!(
        discover_session_id_by_prompt(
            AgentKind::Codex,
            Path::new(cwd),
            home.path(),
            "target prompt"
        )
        .as_deref(),
        Some(older_id),
    );
}

#[tokio::test]
async fn codex_skips_synthetic_agents_md_injection() {
    // Real-world: every newer Codex rollout starts with a
    // synthetic `role=user` message whose content is the project's
    // AGENTS.md text. That MUST NOT surface as the first user
    // prompt — the typed prompt should win.
    let cwd = "/Users/foo/repo";
    let (home, _) = fake_codex_rollout(
        cwd,
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"# AGENTS.md instructions for /Users/foo/repo\\n\\n<INSTRUCTIONS>...\"}]}}\n\
{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"the real first prompt\"}]}}\n\
{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"the real first prompt\"}}\n",
    );
    let prompts =
        read_session_user_prompts(AgentKind::Codex, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts, vec!["the real first prompt"]);
}

#[tokio::test]
async fn codex_skips_turn_aborted_synthetic_blocks() {
    // After a Ctrl-C cancel Codex injects a `<turn_aborted>`
    // notice as a `role=user` message. Filter the same way as
    // AGENTS.md so the next typed prompt wins.
    let cwd = "/Users/foo/repo";
    let (home, _) = fake_codex_rollout(
        cwd,
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<turn_aborted>\\nthe user interrupted\\n</turn_aborted>\"}]}}\n\
{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"try again\"}]}}\n",
    );
    let prompts =
        read_session_user_prompts(AgentKind::Codex, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts, vec!["try again"]);
}

#[tokio::test]
async fn codex_prefers_event_msg_when_both_shapes_present() {
    // Newer Codex logs the same typed prompt under BOTH shapes.
    // Without de-duplication we'd surface every prompt twice.
    // Preferring `event_msg` also implicitly drops the AGENTS.md
    // injection, which only appears under the `response_item`
    // shape.
    let cwd = "/Users/foo/repo";
    let (home, _) = fake_codex_rollout(
        cwd,
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"# AGENTS.md instructions for /Users/foo/repo\\n...\"}]}}\n\
{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"first\"}]}}\n\
{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"first\"}}\n\
{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"second\"}]}}\n\
{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"second\"}}\n",
    );
    let prompts =
        read_session_user_prompts(AgentKind::Codex, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts, vec!["first", "second"]);
}

#[tokio::test]
async fn codex_ignores_assistant_and_tool_blocks() {
    let cwd = "/Users/foo/repo";
    let (home, _) = fake_codex_rollout(
        cwd,
        "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"real\"}]}}\n\
{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"ls\"}}\n\
{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"output\":\"...\"}}\n",
    );
    let prompts =
        read_session_user_prompts(AgentKind::Codex, Path::new(cwd), home.path(), None).await;
    assert_eq!(prompts, vec!["real"]);
}

#[tokio::test]
async fn codex_missing_session_dir_returns_empty() {
    let home = tempdir().unwrap();
    let cwd = Path::new("/Users/foo/repo");
    assert!(
        read_session_user_prompts(AgentKind::Codex, cwd, home.path(), None)
            .await
            .is_empty()
    );
}

#[tokio::test]
async fn empty_cwd_yields_nothing() {
    let home = tempdir().unwrap();
    assert_eq!(encode_cwd_for_claude(Path::new("")), None);
    assert!(
        read_session_user_prompts(AgentKind::ClaudeCode, Path::new(""), home.path(), None)
            .await
            .is_empty()
    );
}

#[test]
fn claude_id_lookup_picks_exact_jsonl_even_when_others_are_newer() {
    // Multi-pane regression: previously every pane in the same
    // worktree resolved to the same "newest jsonl". With the
    // captured harness session id, the lookup targets exactly the
    // file Claude assigned to that pane.
    let cwd = "/Users/foo/repo";
    let home = tempdir().unwrap();
    let encoded: String = cwd
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    let dir = home.path().join(".claude").join("projects").join(encoded);
    fs::create_dir_all(&dir).unwrap();

    // Older jsonl that belongs to *our* session.
    let ours = dir.join("aaaa-1111.jsonl");
    fs::write(
        &ours,
        r#"{"type":"user","message":{"role":"user","content":"my real task"}}
"#,
    )
    .unwrap();
    sleep(Duration::from_millis(50));

    // Newer jsonl from a different session in the same worktree.
    // This is the file the directory-newest heuristic would pick.
    let other = dir.join("bbbb-2222.jsonl");
    fs::write(
        &other,
        r#"{"type":"user","message":{"role":"user","content":"someone else's task"}}
"#,
    )
    .unwrap();

    let prompts = read_session_user_prompts_for_id(
        AgentKind::ClaudeCode,
        Path::new(cwd),
        home.path(),
        "aaaa-1111",
        None,
    );
    assert_eq!(prompts, vec!["my real task"]);
}

#[test]
fn claude_id_lookup_returns_empty_when_file_missing() {
    // No fallback to newest-jsonl: if the captured id doesn't
    // resolve to a file we return empty rather than surface a
    // sibling session's prompts. Falling back was the original bug
    // — multiple panes sharing one worktree all saw the same
    // "newest" jsonl as their Task.
    let cwd = "/Users/foo/repo";
    let (home, jsonl) = fake_claude_home(cwd);
    fs::write(
        &jsonl,
        r#"{"type":"user","message":{"role":"user","content":"some other session's prompt"}}
"#,
    )
    .unwrap();

    let prompts = read_session_user_prompts_for_id(
        AgentKind::ClaudeCode,
        Path::new(cwd),
        home.path(),
        "missing-id",
        None,
    );
    assert!(
        prompts.is_empty(),
        "expected empty Vec, got {prompts:?} — fallback would surface another session's prompts",
    );
}

#[test]
fn codex_id_lookup_picks_rollout_by_filename_suffix() {
    // Codex rollout filenames embed the session id as the trailing
    // segment before `.jsonl`. The id-targeted lookup walks the
    // YYYY/MM/DD tree until it hits the matching file.
    let cwd = "/Users/foo/repo";
    let home = tempdir().unwrap();
    let dir = home
        .path()
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("04")
        .join("29");
    fs::create_dir_all(&dir).unwrap();

    // Other rollout in the same date — must not be picked even if
    // it happens to live next to ours.
    let other = dir.join("rollout-2026-04-29T10-00-00-other-id.jsonl");
    fs::write(
        &other,
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"unrelated\"}}\n",
    )
    .unwrap();

    // Ours: id matches the suffix the lookup targets.
    let ours = dir.join("rollout-2026-04-29T11-00-00-target-id.jsonl");
    fs::write(
        &ours,
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"target task\"}}\n",
    )
    .unwrap();

    let prompts = read_session_user_prompts_for_id(
        AgentKind::Codex,
        Path::new(cwd),
        home.path(),
        "target-id",
        None,
    );
    assert_eq!(prompts, vec!["target task"]);
}
