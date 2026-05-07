//! Per-harness model discovery for the cross-review picker.
//!
//! Each harness exposes a different surface for "which models can I run?":
//!
//! * **Claude Code** — no `claude models` subcommand and no per-account list
//!   endpoint. We ship a small curated default list of aliases (`opus`,
//!   `sonnet`, `haiku`) and opportunistically enrich it by scanning the
//!   installed `claude` binary for embedded model IDs that match
//!   `claude-(opus|sonnet|haiku)-…`. The scan is best-effort: if the binary
//!   is missing or the pattern doesn't match, callers still get the curated
//!   list. Effort levels (`--effort low|medium|high|xhigh|max`) are static.
//! * **Codex** — read `~/.codex/models_cache.json`, which Codex itself
//!   maintains (HTTP-fetched, ETagged). Each entry carries `slug`,
//!   `display_name`, `default_reasoning_level`, `supported_reasoning_levels[]`,
//!   `visibility`. We filter `visibility == "list"` and sort by `priority`.
//! * **OpenCode** — shell out to `opencode models`, which prints one
//!   `provider/model` slug per line. Effort/thinking is per-provider-family
//!   in `opencode.json` and is out of scope for v1; we only return the
//!   model list. On any spawn / timeout / non-zero exit we fall back to a
//!   curated list (`opencode_fallback`) so the picker is never empty.
//!
//! All discovery runs in async functions because Codex's JSON read and
//! OpenCode's child-process spawn benefit from non-blocking IO and a hard
//! timeout. Callers (the Tauri command + tests) await once.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;
use tracing::warn;

use crate::agent::AgentKind;

/// Wire shape for a single picker entry. `id` is what we pass to the harness
/// (e.g. `opus`, `claude-sonnet-4-6`, `gpt-5.4`, `github-copilot/claude-opus-4.7`);
/// `label` is what the picker shows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessModel {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supported_efforts: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
}

/// Effort levels the `claude` CLI accepts via `--effort <level>`. Per-model
/// availability is not surfaced anywhere; we apply the full set uniformly.
pub const CLAUDE_EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Reasoning-effort levels we expose for OpenCode-served models. OpenCode
/// itself plumbs effort per provider in `opencode.json`
/// (`provider.options.reasoning.effort`); the modern providers it routes
/// to (Anthropic, GPT-5 family, github-copilot) all accept this trio.
/// Apply uniformly to every discovered/fallback OpenCode slug — the
/// downstream `modelOverride` is dropped silently if a provider doesn't
/// honour reasoning, so a uniform set is safe for v1.
pub const OPENCODE_EFFORTS: [&str; 3] = ["low", "medium", "high"];

/// Hard timeout for `opencode models`. The hot path is ~1.5 s on a fast
/// machine; a cold models.dev cache (HTTP fetch on first run after
/// install) can push closer to this cap.
const OPENCODE_TIMEOUT: Duration = Duration::from_secs(8);

/// Cap how many bytes of the `claude` binary we'll scan looking for embedded
/// model strings. The bundled binary is large (~200 MB) but model IDs cluster
/// inside the JS payload near the head; in practice the first 80 MB is more
/// than enough. Bounded so the picker stays snappy on first open.
const CLAUDE_SCAN_CAP_BYTES: u64 = 80 * 1024 * 1024;

/// Discover the available models for `kind`. Async because two of the three
/// providers do IO with timeouts.
pub async fn list_models(kind: AgentKind) -> Vec<HarnessModel> {
    match kind {
        AgentKind::ClaudeCode => claude_models().await,
        AgentKind::Codex => codex_models().await,
        AgentKind::OpenCode => opencode_models().await,
        AgentKind::Shell => Vec::new(),
    }
}

// ---- Claude Code -----------------------------------------------------------

fn claude_curated() -> Vec<HarnessModel> {
    let efforts: Vec<String> = CLAUDE_EFFORTS.iter().map(|s| (*s).to_string()).collect();
    [
        ("opus", "Opus (alias)"),
        ("sonnet", "Sonnet (alias)"),
        ("haiku", "Haiku (alias)"),
    ]
    .iter()
    .map(|(id, label)| HarnessModel {
        id: (*id).to_string(),
        label: (*label).to_string(),
        supported_efforts: efforts.clone(),
        default_effort: Some("medium".to_string()),
    })
    .collect()
}

async fn claude_models() -> Vec<HarnessModel> {
    let mut models = claude_curated();
    if let Some(path) = locate_claude_binary().await
        && let Ok(extracted) = scan_claude_binary(&path).await
    {
        let efforts: Vec<String> = CLAUDE_EFFORTS.iter().map(|s| (*s).to_string()).collect();
        let existing: std::collections::HashSet<String> =
            models.iter().map(|m| m.id.clone()).collect();
        for id in extracted {
            if existing.contains(&id) {
                continue;
            }
            models.push(HarnessModel {
                label: id.clone(),
                id,
                supported_efforts: efforts.clone(),
                default_effort: Some("medium".to_string()),
            });
        }
    }
    models
}

/// Resolve the installed `claude` binary by following `which claude` through
/// any symlinks. Returns `None` when claude isn't on `PATH`.
async fn locate_claude_binary() -> Option<PathBuf> {
    let p = which::which("claude").ok()?;
    Some(tokio::fs::canonicalize(&p).await.unwrap_or(p))
}

/// Stream-scan the binary for ASCII byte sequences matching
/// `claude-(opus|sonnet|haiku)-<digits>(-<digits>)?(@<digits>)?(\[1m\])?`.
///
/// We don't pull `regex` into raum-core just for this; the pattern is
/// constrained enough to validate by hand. We read in 1 MiB chunks with a
/// 64-byte overlap so a candidate that straddles a chunk boundary still gets
/// matched.
async fn scan_claude_binary(path: &Path) -> std::io::Result<Vec<String>> {
    use std::collections::BTreeSet;

    const CHUNK: usize = 1024 * 1024;
    const OVERLAP: usize = 64;
    let mut file = tokio::fs::File::open(path).await?;
    let mut total: u64 = 0;
    let mut tail: Vec<u8> = Vec::with_capacity(OVERLAP);
    let mut found: BTreeSet<String> = BTreeSet::new();
    loop {
        if total >= CLAUDE_SCAN_CAP_BYTES {
            break;
        }
        let mut buf = vec![0u8; CHUNK];
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        buf.truncate(n);
        total += n as u64;
        let combined: Vec<u8> = if tail.is_empty() {
            buf.clone()
        } else {
            let mut v = Vec::with_capacity(tail.len() + buf.len());
            v.extend_from_slice(&tail);
            v.extend_from_slice(&buf);
            v
        };
        for id in extract_claude_ids(&combined) {
            found.insert(id);
        }
        let keep = combined.len().saturating_sub(OVERLAP);
        tail = combined[keep..].to_vec();
        if found.len() >= 200 {
            break;
        }
    }
    let mut out: Vec<String> = found.into_iter().collect();
    // Stable, useful display order: full IDs (claude-*) only — drop anything
    // weird that snuck through the validator.
    out.retain(|s| s.starts_with("claude-"));
    Ok(out)
}

/// Walk `bytes` and collect every ASCII run that looks like a Claude model id.
fn extract_claude_ids(bytes: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let needle = b"claude-";
    let mut i = 0;
    while i + needle.len() <= bytes.len() {
        if &bytes[i..i + needle.len()] == needle {
            // Walk forward while bytes are part of an ID.
            let start = i;
            let mut end = i + needle.len();
            while end < bytes.len() && is_claude_id_byte(bytes[end]) {
                end += 1;
            }
            if let Ok(s) = std::str::from_utf8(&bytes[start..end])
                && is_valid_claude_id(s)
            {
                out.push(s.to_string());
            }
            i = end.max(start + 1);
        } else {
            i += 1;
        }
    }
    out
}

fn is_claude_id_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'@' | b'[' | b']')
}

/// Validate that `s` parses as `claude-(opus|sonnet|haiku)-<digits>` plus the
/// optional `-<digits>`, `@<digits>`, `[1m]` tail seen in the embedded catalog.
/// Anything that doesn't match (regex source, error messages with the prefix,
/// etc.) is rejected so the picker doesn't end up showing junk.
fn is_valid_claude_id(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("claude-") else {
        return false;
    };
    let rest = if let Some(r) = rest.strip_prefix("opus-") {
        r
    } else if let Some(r) = rest.strip_prefix("sonnet-") {
        r
    } else if let Some(r) = rest.strip_prefix("haiku-") {
        r
    } else {
        return false;
    };
    // Optional `[1m]` 1-million-context suffix.
    let rest = rest.strip_suffix("[1m]").unwrap_or(rest);
    // Body is 1–3 dash-separated segments. Each segment is either `<digits>`
    // or `<digits>@<digits>` (the dated-build form, e.g. `4@20250514`).
    let segments: Vec<&str> = rest.split('-').collect();
    if segments.is_empty() || segments.len() > 3 {
        return false;
    }
    segments.iter().all(|seg| is_valid_claude_segment(seg))
}

fn is_valid_claude_segment(seg: &str) -> bool {
    if seg.is_empty() {
        return false;
    }
    if let Some((a, b)) = seg.split_once('@') {
        !a.is_empty()
            && a.chars().all(|c| c.is_ascii_digit())
            && !b.is_empty()
            && b.chars().all(|c| c.is_ascii_digit())
    } else {
        seg.chars().all(|c| c.is_ascii_digit())
    }
}

// ---- Codex -----------------------------------------------------------------

#[derive(Deserialize)]
struct CodexCache {
    models: Vec<CodexModel>,
}

#[derive(Deserialize)]
struct CodexModel {
    slug: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    default_reasoning_level: Option<String>,
    #[serde(default)]
    supported_reasoning_levels: Vec<CodexEffort>,
    #[serde(default)]
    visibility: Option<String>,
    #[serde(default)]
    priority: Option<i64>,
}

#[derive(Deserialize)]
struct CodexEffort {
    effort: String,
}

async fn codex_models() -> Vec<HarnessModel> {
    let path = codex_models_cache_path();
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(_) => return codex_fallback(),
    };
    let cache: CodexCache = match serde_json::from_slice(&bytes) {
        Ok(c) => c,
        Err(_) => return codex_fallback(),
    };
    let mut entries: Vec<CodexModel> = cache
        .models
        .into_iter()
        .filter(|m| m.visibility.as_deref() == Some("list"))
        .collect();
    // Higher priority first (the cache uses `priority`: lower number ≈ default
    // pinned, but the user-visible expectation is "most-relevant on top". The
    // observed cache puts default models at priority 1–2, ascending; sort
    // ascending so the default appears first).
    entries.sort_by_key(|m| m.priority.unwrap_or(i64::MAX));
    let out: Vec<HarnessModel> = entries
        .into_iter()
        .map(|m| {
            let supported_efforts: Vec<String> = m
                .supported_reasoning_levels
                .into_iter()
                .map(|e| e.effort)
                .collect();
            let label = m.display_name.unwrap_or_else(|| m.slug.clone());
            HarnessModel {
                id: m.slug,
                label,
                supported_efforts,
                default_effort: m.default_reasoning_level,
            }
        })
        .collect();
    if out.is_empty() {
        codex_fallback()
    } else {
        out
    }
}

fn codex_fallback() -> Vec<HarnessModel> {
    let efforts = vec![
        "low".to_string(),
        "medium".to_string(),
        "high".to_string(),
        "xhigh".to_string(),
    ];
    vec![
        HarnessModel {
            id: "gpt-5.4".to_string(),
            label: "gpt-5.4".to_string(),
            supported_efforts: efforts.clone(),
            default_effort: Some("medium".to_string()),
        },
        HarnessModel {
            id: "gpt-5.3-codex".to_string(),
            label: "gpt-5.3-codex".to_string(),
            supported_efforts: efforts,
            default_effort: Some("medium".to_string()),
        },
    ]
}

fn codex_models_cache_path() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(".codex")
        .join("models_cache.json")
}

// ---- OpenCode --------------------------------------------------------------

async fn opencode_models() -> Vec<HarnessModel> {
    let mut cmd = Command::new("opencode");
    cmd.args(["models"]);
    let fut = cmd.output();
    let output = match timeout(OPENCODE_TIMEOUT, fut).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => {
            warn!(error = %e, "opencode_models: spawn failed; using fallback");
            return opencode_fallback();
        }
        Err(_) => {
            warn!(timeout = ?OPENCODE_TIMEOUT, "opencode_models: timed out; using fallback");
            return opencode_fallback();
        }
    };
    if !output.status.success() {
        warn!(
            status = ?output.status.code(),
            stderr = %String::from_utf8_lossy(&output.stderr).trim(),
            "opencode_models: non-zero exit; using fallback",
        );
        return opencode_fallback();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let models = parse_opencode_models(&stdout);
    if models.is_empty() {
        warn!(
            stdout_len = stdout.len(),
            "opencode_models: parser produced zero entries; using fallback",
        );
        return opencode_fallback();
    }
    models
}

/// Curated fallback list when `opencode models` cannot be queried (binary
/// missing, timeout, non-zero exit, unparsable output). Slugs verified
/// against a current `opencode models` listing — common enough to be
/// available on most accounts. The picker still works the moment the
/// user clicks the refresh button (or when discovery succeeds on a
/// later attempt).
fn opencode_fallback() -> Vec<HarnessModel> {
    let efforts: Vec<String> = OPENCODE_EFFORTS.iter().map(|s| (*s).to_string()).collect();
    [
        "opencode/big-pickle",
        "github-copilot/claude-opus-4.7",
        "github-copilot/claude-sonnet-4.6",
        "github-copilot/claude-haiku-4.5",
        "github-copilot/gpt-5.4",
    ]
    .iter()
    .map(|slug| HarnessModel {
        id: (*slug).to_string(),
        label: (*slug).to_string(),
        supported_efforts: efforts.clone(),
        default_effort: Some("medium".to_string()),
    })
    .collect()
}

fn parse_opencode_models(stdout: &str) -> Vec<HarnessModel> {
    let efforts: Vec<String> = OPENCODE_EFFORTS.iter().map(|s| (*s).to_string()).collect();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in stdout.lines() {
        // `opencode models` prints one `provider/model` slug per line. Take
        // the first whitespace-delimited token and trust the slash as a
        // sentinel — any banner / header line lacks it. Robust to the
        // verbose mode's metadata columns too, in case a caller adds them.
        let token = line.split_whitespace().next().unwrap_or("").trim();
        if !token.contains('/') {
            continue;
        }
        if !seen.insert(token.to_string()) {
            continue;
        }
        out.push(HarnessModel {
            id: token.to_string(),
            label: token.to_string(),
            supported_efforts: efforts.clone(),
            default_effort: Some("medium".to_string()),
        });
    }
    out
}

// ---- helpers ---------------------------------------------------------------

fn home_dir() -> Option<PathBuf> {
    if let Some(dirs) = directories::BaseDirs::new() {
        return Some(dirs.home_dir().to_path_buf());
    }
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_real_claude_ids() {
        let real = [
            "claude-haiku-3-5",
            "claude-haiku-4",
            "claude-haiku-4-5",
            "claude-haiku-4-5-20251001",
            "claude-haiku-4-5@20251001",
            "claude-opus-4-7",
            "claude-opus-4-1-20250805",
            "claude-opus-4-1@20250805",
            "claude-opus-4-6[1m]",
            "claude-sonnet-4-5-20250929",
            "claude-sonnet-4-5-20250929[1m]",
            "claude-sonnet-4@20250514",
            "claude-sonnet-3-7",
        ];
        for id in real {
            assert!(is_valid_claude_id(id), "expected to accept {id}");
        }
    }

    #[test]
    fn rejects_non_model_strings() {
        let bad = [
            "claude-foo-1",                   // unknown family
            "claude-opus-4(?!-\\d(?!\\d))",   // regex source from binary
            "claude-opus-4-",                 // trailing dash
            "claude-",                        // bare prefix
            "claude-sonnet-",                 // empty body
            "claude-haiku-x",                 // non-digit
            "claude-opus-4-x",                // non-digit second segment
            "claude-opus-4-1-20250805-extra", // too many segments
        ];
        for id in bad {
            assert!(!is_valid_claude_id(id), "expected to reject {id}");
        }
    }

    #[test]
    fn extract_walks_concatenated_ids() {
        let blob = b"junk\x00claude-opus-4-7\x00more\x00claude-sonnet-4-6\x00";
        let ids = extract_claude_ids(blob);
        assert!(ids.contains(&"claude-opus-4-7".to_string()));
        assert!(ids.contains(&"claude-sonnet-4-6".to_string()));
    }

    #[test]
    fn extract_skips_invalid_neighbours() {
        // Regex source like the binary contains. The validator should reject.
        let blob = b"claude-opus-4(?!-\\d)";
        let ids = extract_claude_ids(blob);
        // The walker stops at `(`, so the candidate is `claude-opus-4` which
        // is a valid prefix but has no second segment — accepted by the
        // current validator (first-segment-only is allowed). That's fine for
        // a curated picker. Make sure we don't accept the regex tail.
        assert!(!ids.iter().any(|s| s.contains("?!")));
    }

    #[test]
    fn claude_curated_has_three_aliases() {
        let m = claude_curated();
        let ids: Vec<&str> = m.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["opus", "sonnet", "haiku"]);
        for entry in &m {
            assert_eq!(entry.supported_efforts.len(), CLAUDE_EFFORTS.len());
        }
    }

    #[test]
    fn parses_codex_cache_fixture() {
        // Minimal slice of the real ~/.codex/models_cache.json.
        let json = r#"{
          "fetched_at": "2026-04-15T18:10:47.455013Z",
          "models": [
            {
              "slug": "gpt-5.4",
              "display_name": "gpt-5.4",
              "default_reasoning_level": "medium",
              "supported_reasoning_levels": [
                {"effort": "low", "description": "fast"},
                {"effort": "medium", "description": "balanced"},
                {"effort": "high", "description": "deep"},
                {"effort": "xhigh", "description": "xtra"}
              ],
              "visibility": "list",
              "priority": 1
            },
            {
              "slug": "gpt-internal",
              "visibility": "hidden",
              "priority": 0
            },
            {
              "slug": "gpt-5.3-codex",
              "supported_reasoning_levels": [{"effort": "medium", "description": ""}],
              "visibility": "list",
              "priority": 2
            }
          ]
        }"#;
        let cache: CodexCache = serde_json::from_str(json).expect("parses");
        let entries: Vec<HarnessModel> = cache
            .models
            .into_iter()
            .filter(|m| m.visibility.as_deref() == Some("list"))
            .map(|m| {
                let supported_efforts: Vec<String> = m
                    .supported_reasoning_levels
                    .into_iter()
                    .map(|e| e.effort)
                    .collect();
                HarnessModel {
                    id: m.slug.clone(),
                    label: m.display_name.unwrap_or(m.slug),
                    supported_efforts,
                    default_effort: m.default_reasoning_level,
                }
            })
            .collect();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, "gpt-5.4");
        assert_eq!(entries[0].supported_efforts.len(), 4);
        assert_eq!(entries[0].default_effort.as_deref(), Some("medium"));
        assert_eq!(entries[1].id, "gpt-5.3-codex");
    }

    #[test]
    fn parses_opencode_models_output() {
        let stdout = "opencode/big-pickle\nopencode/gpt-5-nano    $0.10\ngithub-copilot/claude-opus-4.7\nheader-without-slash\n";
        let m = parse_opencode_models(stdout);
        let ids: Vec<&str> = m.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "opencode/big-pickle",
                "opencode/gpt-5-nano",
                "github-copilot/claude-opus-4.7"
            ]
        );
        // Every OpenCode entry now carries a uniform effort set so the
        // picker can offer reasoning levels for any provider.
        assert!(
            m.iter()
                .all(|x| x.supported_efforts == OPENCODE_EFFORTS.map(String::from)),
        );
        assert!(
            m.iter()
                .all(|x| x.default_effort.as_deref() == Some("medium")),
        );
    }

    #[test]
    fn opencode_dedupes_repeated_lines() {
        let stdout = "opencode/x\nopencode/x\nopencode/y\n";
        let m = parse_opencode_models(stdout);
        assert_eq!(m.len(), 2);
    }

    #[test]
    fn opencode_fallback_is_non_empty_and_includes_github_copilot() {
        let m = opencode_fallback();
        assert!(
            !m.is_empty(),
            "fallback must always have at least one entry"
        );
        assert!(
            m.iter().any(|x| x.id.starts_with("github-copilot/")),
            "fallback should include common github-copilot slugs",
        );
        for entry in &m {
            assert!(
                entry.id.contains('/'),
                "every fallback id must be a provider/model slug, got {}",
                entry.id,
            );
            assert_eq!(
                entry.supported_efforts.len(),
                OPENCODE_EFFORTS.len(),
                "fallback entry {} should expose the full effort set",
                entry.id,
            );
            assert_eq!(entry.default_effort.as_deref(), Some("medium"));
        }
    }

    #[tokio::test]
    async fn shell_kind_returns_empty() {
        let m = list_models(AgentKind::Shell).await;
        assert!(m.is_empty());
    }
}
