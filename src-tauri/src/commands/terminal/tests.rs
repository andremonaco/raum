//! Consolidated unit tests for the terminal command surface. Pre-refactor
//! these lived as four separate `#[cfg(test)] mod` blocks inside
//! `terminal.rs`; they are kept distinct here so the test names + failure
//! output stay byte-identical.

mod ghost_tests {
    use super::super::registry::{GhostEntry, TerminalRegistry};
    use raum_core::AgentKind;

    fn ghost(id: &str, slug: Option<&str>) -> GhostEntry {
        GhostEntry {
            session_id: id.to_string(),
            project_slug: slug.map(str::to_string),
            worktree_id: None,
            kind: AgentKind::ClaudeCode,
            created_unix: 42,
            dead: false,
        }
    }

    #[test]
    fn upsert_ghost_exposes_session_in_list() {
        let mut reg = TerminalRegistry::default();
        assert!(reg.upsert_ghost(ghost("raum-a", Some("acme"))));
        let listed = reg.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, "raum-a");
        assert_eq!(listed[0].project_slug.as_deref(), Some("acme"));
        assert_eq!(listed[0].kind, AgentKind::ClaudeCode);
    }

    #[test]
    fn upsert_ghost_is_idempotent() {
        let mut reg = TerminalRegistry::default();
        assert!(reg.upsert_ghost(ghost("raum-a", Some("acme"))));
        // Re-upserting overwrites (for instance, if the rehydrate
        // bootstrap re-runs — shouldn't happen today, but defensive).
        assert!(reg.upsert_ghost(ghost("raum-a", Some("other"))));
        let listed = reg.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].project_slug.as_deref(), Some("other"));
    }

    #[test]
    fn promote_ghost_removes_from_map_and_returns_metadata() {
        let mut reg = TerminalRegistry::default();
        reg.upsert_ghost(ghost("raum-a", Some("acme")));
        let promoted = reg.promote_ghost("raum-a");
        assert!(promoted.is_some(), "promote returns the ghost");
        assert!(reg.list().is_empty(), "ghost is removed from list");
        assert!(
            reg.promote_ghost("raum-a").is_none(),
            "second promote is None"
        );
    }

    #[test]
    fn ghost_is_not_returned_by_get_bridge() {
        let mut reg = TerminalRegistry::default();
        reg.upsert_ghost(ghost("raum-a", Some("acme")));
        // Ghosts intentionally lack a PTY bridge — `get_bridge`
        // returns None so `terminal_send_keys` / `terminal_resize`
        // short-circuit with `"not-found"` until reattach promotes
        // the ghost.
        assert!(reg.get_bridge("raum-a").is_none());
        assert!(reg.get_bridge_and_size("raum-a").is_none());
    }

    #[test]
    fn remove_drops_ghost_rows_too() {
        let mut reg = TerminalRegistry::default();
        reg.upsert_ghost(ghost("raum-a", Some("acme")));
        // No real entry to remove, but the method should still clear
        // the ghost so a subsequent `list` is empty.
        assert!(reg.remove("raum-a").is_none());
        assert!(reg.list().is_empty());
    }
}

mod misc_tests {
    use super::super::bridge::should_emit_pane_context_change;
    use super::super::entry::PaneContextPayload;
    use super::super::helpers::{
        contains_abort_input, contains_submit_input, resolve_reattach_context,
    };
    use raum_core::agent::AgentState;

    #[test]
    fn submit_input_detector_ignores_plain_typing() {
        assert!(!contains_submit_input("hello world"));
        assert!(!contains_submit_input("abc\tdef"));
    }

    #[test]
    fn submit_input_detector_matches_return_and_newline() {
        assert!(contains_submit_input("\r"));
        assert!(contains_submit_input("\n"));
        assert!(contains_submit_input("hello\r"));
        assert!(contains_submit_input("hello\nworld"));
    }

    #[test]
    fn abort_input_ctrl_c_fires_regardless_of_state() {
        assert!(contains_abort_input("\x03", None));
        assert!(contains_abort_input("\x03", Some(AgentState::Working)));
        assert!(contains_abort_input("\x03", Some(AgentState::Waiting)));
        assert!(contains_abort_input("\x03", Some(AgentState::Idle)));
    }

    #[test]
    fn abort_input_esc_fires_only_when_waiting() {
        assert!(contains_abort_input("\x1b", Some(AgentState::Waiting)));
        assert!(!contains_abort_input("\x1b", Some(AgentState::Working)));
        assert!(!contains_abort_input("\x1b", Some(AgentState::Idle)));
        assert!(!contains_abort_input("\x1b", None));
    }

    #[test]
    fn abort_input_plain_keys_never_fire() {
        assert!(!contains_abort_input("", Some(AgentState::Waiting)));
        assert!(!contains_abort_input("hello", Some(AgentState::Waiting)));
        assert!(!contains_abort_input("a\tb", Some(AgentState::Working)));
    }

    #[test]
    fn pane_context_change_emits_first_snapshot_once() {
        let next = PaneContextPayload {
            current_command: "node".into(),
            current_path: "/tmp/raum".into(),
            pane_title: "Investigating flake".into(),
            window_name: "node".into(),
        };
        assert!(should_emit_pane_context_change(None, &next));
        assert!(!should_emit_pane_context_change(Some(&next), &next));
    }

    #[test]
    fn pane_context_change_dedupes_identical_snapshots() {
        let previous = PaneContextPayload {
            current_command: "node".into(),
            current_path: "/tmp/raum".into(),
            pane_title: "Investigating flake".into(),
            window_name: "node".into(),
        };
        let next = previous.clone();
        assert!(!should_emit_pane_context_change(Some(&previous), &next));
    }

    #[test]
    fn pane_context_change_emits_when_titles_change() {
        let previous = PaneContextPayload {
            current_command: "node".into(),
            current_path: "/tmp/raum".into(),
            pane_title: "Investigating flake".into(),
            window_name: "node".into(),
        };
        let renamed_pane = PaneContextPayload {
            pane_title: "Reviewing fixes".into(),
            ..previous.clone()
        };
        let renamed_window = PaneContextPayload {
            window_name: "branch/fix-title".into(),
            ..previous.clone()
        };
        assert!(should_emit_pane_context_change(
            Some(&previous),
            &renamed_pane
        ));
        assert!(should_emit_pane_context_change(
            Some(&previous),
            &renamed_window
        ));
    }

    #[test]
    fn reattach_context_prefers_args_then_registry_then_ghost_then_tracked() {
        let (project, worktree) = resolve_reattach_context(
            (Some("args-project"), Some("args-worktree")),
            (Some("registry-project"), Some("registry-worktree")),
            (Some("ghost-project"), Some("ghost-worktree")),
            (Some("tracked-project"), Some("tracked-worktree")),
        );
        assert_eq!(project.as_deref(), Some("args-project"));
        assert_eq!(worktree.as_deref(), Some("args-worktree"));

        let (project, worktree) = resolve_reattach_context(
            (None, None),
            (Some("registry-project"), Some("registry-worktree")),
            (Some("ghost-project"), Some("ghost-worktree")),
            (Some("tracked-project"), Some("tracked-worktree")),
        );
        assert_eq!(project.as_deref(), Some("registry-project"));
        assert_eq!(worktree.as_deref(), Some("registry-worktree"));

        let (project, worktree) = resolve_reattach_context(
            (None, None),
            (None, None),
            (Some("ghost-project"), Some("ghost-worktree")),
            (Some("tracked-project"), Some("tracked-worktree")),
        );
        assert_eq!(project.as_deref(), Some("ghost-project"));
        assert_eq!(worktree.as_deref(), Some("ghost-worktree"));

        let (project, worktree) = resolve_reattach_context(
            (None, None),
            (None, None),
            (None, None),
            (Some("tracked-project"), Some("tracked-worktree")),
        );
        assert_eq!(project.as_deref(), Some("tracked-project"));
        assert_eq!(worktree.as_deref(), Some("tracked-worktree"));
    }
}

mod opencode_port_tests {
    use raum_core::harness::parse_opencode_port_arg;

    #[test]
    fn parses_space_separated_port_flag() {
        assert_eq!(
            parse_opencode_port_arg("--port 5123 --agent build"),
            Some(5123)
        );
    }

    #[test]
    fn parses_equals_port_flag() {
        assert_eq!(
            parse_opencode_port_arg("--agent build --port=5123"),
            Some(5123)
        );
    }

    #[test]
    fn ignores_missing_or_invalid_port_flag() {
        assert_eq!(parse_opencode_port_arg("--agent build"), None);
        assert_eq!(parse_opencode_port_arg("--port nope"), None);
    }
}

mod paste_payload_tests {
    use super::super::io::format_paste_payload;

    #[test]
    fn harness_mode_joins_raw_paths_without_quoting() {
        let paths = vec![
            "/tmp/hello world.md".to_string(),
            "/tmp/a'b.txt".to_string(),
        ];
        let got = format_paste_payload(&paths, "harness");
        // Exactly as dropped — no backslashes, no quotes, no trailing space.
        assert_eq!(got, "/tmp/hello world.md /tmp/a'b.txt");
    }

    #[test]
    fn shell_mode_posix_quotes_with_trailing_space() {
        let paths = vec!["/tmp/hello world.md".to_string()];
        let got = format_paste_payload(&paths, "shell");
        assert_eq!(got, "'/tmp/hello world.md' ");
    }

    #[test]
    fn shell_mode_escapes_embedded_single_quotes() {
        let paths = vec!["/tmp/it's.md".to_string()];
        let got = format_paste_payload(&paths, "shell");
        assert_eq!(got, "'/tmp/it'\\''s.md' ");
    }

    #[test]
    fn unknown_mode_falls_through_to_shell_semantics() {
        let paths = vec!["/tmp/a.txt".to_string()];
        let got = format_paste_payload(&paths, "wat");
        assert_eq!(got, "'/tmp/a.txt' ");
    }
}
