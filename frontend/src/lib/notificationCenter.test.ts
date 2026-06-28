import { describe, it, expect, beforeEach, vi } from "vitest";

// Stub out the Tauri runtime surface the notification center touches.
// These modules aren't resolvable under vitest/jsdom, and we want every
// IPC to be a spy so we can assert on the payloads. Note that
// `tauri-plugin-notification` is GONE — all OS notification dispatch
// flows through the Rust `notifications_send` command via `invoke()`,
// so its calls land in `mockInvoke` like every other backend command.
const mockInvoke = vi.fn();
const listenHandlers = new Map<string, (ev: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi
    .fn()
    .mockImplementation(async (event: string, cb: (ev: { payload: unknown }) => void) => {
      listenHandlers.set(event, cb);
      return () => {
        listenHandlers.delete(event);
      };
    }),
}));
// `startNotificationCenter` seeds + subscribes to window focus. Stub the
// window API so it resolves under jsdom; the focus tests drive the signal
// directly via `__setWindowFocusedForTests` instead.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFocused: async () => false,
    onFocusChanged: async () => () => {},
  }),
}));

import {
  __clearPendingPermissionForTests,
  __handleAgentStateChangedForTests,
  __handleNotificationEventForTests,
  __handleSessionRemovedForTests,
  __resetNotificationCenterForTests,
  __setWindowFocusedForTests,
  badgeMode,
  ensureNotificationPermission,
  pendingPermissionCount,
  startNotificationCenter,
  syncDockBadge,
} from "./notificationCenter";
import { __resetProjectStoreForTests, upsertProject } from "../stores/projectStore";
import { __resetTerminalStoreForTests, upsertTerminal } from "../stores/terminalStore";
import type { AgentKind } from "../stores/agentStore";

function seedProject(slug: string, name: string, sigil: string): void {
  upsertProject({
    slug,
    name,
    color: "#000000",
    sigil,
    rootPath: `/tmp/${slug}`,
    inRepoSettings: false,
    hasRaumToml: false,
    hidden: false,
  });
}

function seedSession(sessionId: string, kind: AgentKind, projectSlug: string | null): void {
  upsertTerminal({
    session_id: sessionId,
    project_slug: projectSlug,
    worktree_id: null,
    kind,
    created_unix: 0,
  });
}

function lastDockBadgeCall(): number | undefined {
  const calls = mockInvoke.mock.calls.filter((c) => c[0] === "set_dock_badge");
  if (calls.length === 0) return undefined;
  const last = calls[calls.length - 1];
  const args = last[1] as { count: number } | undefined;
  return args?.count;
}

interface SendArgs {
  title: string;
  body: string;
  sessionId?: string | null;
  kind?: "done" | "needs_input";
}

interface ClearArgs {
  sessionId: string;
  kinds: Array<"done" | "needs_input">;
}

function sendCalls(): SendArgs[] {
  return mockInvoke.mock.calls
    .filter((c) => c[0] === "notifications_send")
    .map((c) => (c[1] as { args: SendArgs }).args);
}

function clearCalls(): ClearArgs[] {
  return mockInvoke.mock.calls
    .filter((c) => c[0] === "notifications_clear")
    .map((c) => (c[1] as { args: ClearArgs }).args);
}

describe("notification center", () => {
  beforeEach(async () => {
    listenHandlers.clear();
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue(undefined);
    __resetNotificationCenterForTests();
    __resetProjectStoreForTests();
    __resetTerminalStoreForTests();
    seedProject("raum", "raum", "α");
    await ensureNotificationPermission();
  });

  it("defaults to all_unread badge mode", () => {
    expect(badgeMode()).toBe("all_unread");
  });

  it("adds to pendingPermissionCount on notification events", async () => {
    expect(pendingPermissionCount()).toBe(0);
    await __handleNotificationEventForTests({
      harness: "claude-code",
      event: "PermissionRequest",
      session_id: "s-1",
      request_id: "req-1",
      permission_key: "req-1",
      payload: null,
    });
    expect(pendingPermissionCount()).toBe(1);

    // A second distinct request increments again.
    await __handleNotificationEventForTests({
      harness: "claude-code",
      event: "PermissionRequest",
      session_id: "s-2",
      request_id: "req-2",
      permission_key: "req-2",
      payload: null,
    });
    expect(pendingPermissionCount()).toBe(2);

    // Duplicate request id is a no-op.
    await __handleNotificationEventForTests({
      harness: "claude-code",
      event: "PermissionRequest",
      session_id: "s-1",
      request_id: "req-1",
      permission_key: "req-1",
      payload: null,
    });
    expect(pendingPermissionCount()).toBe(2);
    expect(sendCalls()).toHaveLength(2);
  });

  it("fires an OS notification for permission requests", async () => {
    await __handleNotificationEventForTests({
      harness: "codex",
      event: "PermissionRequest",
      session_id: "codex-1",
      permission_key: "codex-1",
      payload: { tool_name: "shell" },
    });
    expect(pendingPermissionCount()).toBe(1);
    const calls = sendCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      title: "Permission requested",
      body: "Codex needs permission for shell.",
      sessionId: "codex-1",
    });
  });

  it("fires OS notifications when an agent transitions to waiting", async () => {
    seedSession("s-1", "claude-code", "raum");
    __handleAgentStateChangedForTests({
      session_id: "s-1",
      harness: "claude-code",
      from: "working",
      to: "waiting",
    });
    await Promise.resolve();
    await Promise.resolve();
    const calls = sendCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      title: "α raum",
      body: "Claude needs you.",
      sessionId: "s-1",
    });
  });

  it("fires OS notifications when an agent completes", async () => {
    seedSession("s-2", "codex", "raum");
    __handleAgentStateChangedForTests({
      session_id: "s-2",
      harness: "codex",
      from: "working",
      to: "completed",
    });
    await Promise.resolve();
    await Promise.resolve();
    const calls = sendCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      title: "α raum",
      body: "Codex finished.",
      sessionId: "s-2",
    });
  });

  it("fires OS notifications when an agent errors out", async () => {
    seedSession("s-err", "claude-code", "raum");
    __handleAgentStateChangedForTests({
      session_id: "s-err",
      harness: "claude-code",
      from: "working",
      to: "errored",
    });
    await Promise.resolve();
    await Promise.resolve();
    const calls = sendCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      title: "α raum",
      body: "Claude errored.",
      sessionId: "s-err",
    });
  });

  it("falls back to an empty title when the session's project is unknown", async () => {
    // No seedSession call — terminalStore has no record for this session.
    __handleAgentStateChangedForTests({
      session_id: "orphan",
      harness: "codex",
      from: "working",
      to: "completed",
    });
    await Promise.resolve();
    await Promise.resolve();
    const calls = sendCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      title: "",
      body: "Codex finished.",
      sessionId: "orphan",
    });
  });

  it("suppresses the OS banner for waiting while the window is focused", async () => {
    seedSession("focus-wait", "claude-code", "raum");
    __setWindowFocusedForTests(true);
    __handleAgentStateChangedForTests({
      session_id: "focus-wait",
      harness: "claude-code",
      from: "working",
      to: "waiting",
    });
    await Promise.resolve();
    await Promise.resolve();
    // In-app Attention rail covers the focused case — no OS banner.
    expect(sendCalls()).toHaveLength(0);
  });

  it("suppresses the OS banner for done/errored while the window is focused", async () => {
    __setWindowFocusedForTests(true);
    __handleAgentStateChangedForTests({
      session_id: "focus-done",
      harness: "codex",
      from: "working",
      to: "completed",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sendCalls()).toHaveLength(0);
  });

  it("suppresses the OS banner for permission requests while focused but keeps the badge accurate", async () => {
    __setWindowFocusedForTests(true);
    await __handleNotificationEventForTests({
      harness: "codex",
      event: "PermissionRequest",
      session_id: "focus-perm",
      permission_key: "focus-perm",
      payload: { tool_name: "shell" },
    });
    // The pending-permission counter still increments (drives the badge)…
    expect(pendingPermissionCount()).toBe(1);
    // …but the OS banner is suppressed in favour of the in-app rail.
    expect(sendCalls()).toHaveLength(0);
  });

  it("decrements pendingPermissionCount when a request is cleared", async () => {
    await __handleNotificationEventForTests({
      harness: "claude-code",
      event: "PermissionRequest",
      session_id: "s-1",
      request_id: "req-1",
      permission_key: "req-1",
      payload: null,
    });
    expect(pendingPermissionCount()).toBe(1);

    __clearPendingPermissionForTests("req-1");
    expect(pendingPermissionCount()).toBe(0);

    // Clearing an unknown id is a no-op.
    __clearPendingPermissionForTests("req-does-not-exist");
    expect(pendingPermissionCount()).toBe(0);
  });

  it("clears pending permissions when the session leaves waiting", async () => {
    await __handleNotificationEventForTests({
      harness: "claude-code",
      event: "PermissionRequest",
      session_id: "s-1",
      request_id: "req-1",
      permission_key: "req-1",
      payload: null,
    });
    expect(pendingPermissionCount()).toBe(1);

    __handleAgentStateChangedForTests({
      session_id: "s-1",
      harness: "claude-code",
      from: "waiting",
      to: "working",
    });
    expect(pendingPermissionCount()).toBe(0);
  });

  it("clears pending permissions when the session is removed", async () => {
    await __handleNotificationEventForTests({
      harness: "codex",
      event: "PermissionRequest",
      session_id: "codex-1",
      permission_key: "codex-1",
      payload: null,
    });
    expect(pendingPermissionCount()).toBe(1);

    __handleSessionRemovedForTests("codex-1");
    expect(pendingPermissionCount()).toBe(0);
  });

  it("syncDockBadge dedupes against the previous value", () => {
    syncDockBadge(3);
    syncDockBadge(3);
    syncDockBadge(3);
    const calls = mockInvoke.mock.calls.filter((c) => c[0] === "set_dock_badge");
    expect(calls).toHaveLength(1);
    expect(lastDockBadgeCall()).toBe(3);
  });

  it("syncDockBadge floors negative / fractional counts to integers >= 0", () => {
    syncDockBadge(-5);
    expect(lastDockBadgeCall()).toBe(0);
    syncDockBadge(2.9);
    expect(lastDockBadgeCall()).toBe(2);
  });

  it("dedupes permission + waiting back-to-back into a single OS notification", async () => {
    await __handleNotificationEventForTests({
      harness: "claude-code",
      event: "PermissionRequest",
      session_id: "s-dedup",
      request_id: "req-d",
      permission_key: "req-d",
      payload: { tool_name: "bash" },
    });

    // Backend emits the follow-up `agent-state-changed` in the same loop
    // iteration — in tests we call it synchronously.
    __handleAgentStateChangedForTests({
      session_id: "s-dedup",
      harness: "claude-code",
      from: "working",
      to: "waiting",
    });

    // Let the async waiting dispatcher run.
    await Promise.resolve();
    await Promise.resolve();

    // Exactly one OS notification for the pair — the waiting dispatcher
    // was suppressed by the dedup gate so the user doesn't see two
    // banners for the same logical event.
    expect(sendCalls()).toHaveLength(1);
  });

  it("tags completed transitions with kind=done on the OS notification", async () => {
    __handleAgentStateChangedForTests({
      session_id: "done-1",
      harness: "codex",
      from: "working",
      to: "completed",
    });
    await Promise.resolve();
    await Promise.resolve();
    const calls = sendCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("done");
    expect(calls[0]?.sessionId).toBe("done-1");
  });

  it("tags errored transitions with kind=done on the OS notification", async () => {
    __handleAgentStateChangedForTests({
      session_id: "err-1",
      harness: "claude-code",
      from: "working",
      to: "errored",
    });
    await Promise.resolve();
    await Promise.resolve();
    const calls = sendCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("done");
  });

  it("tags waiting transitions with kind=needs_input on the OS notification", async () => {
    __handleAgentStateChangedForTests({
      session_id: "wait-1",
      harness: "claude-code",
      from: "working",
      to: "waiting",
    });
    await Promise.resolve();
    await Promise.resolve();
    const calls = sendCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("needs_input");
  });

  it("tags permission-event notifications with kind=needs_input", async () => {
    await __handleNotificationEventForTests({
      harness: "codex",
      event: "PermissionRequest",
      session_id: "perm-1",
      permission_key: "perm-1",
      payload: { tool_name: "shell" },
    });
    const calls = sendCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("needs_input");
  });

  it("dismisses needs_input OS notifications when the session leaves waiting", async () => {
    await __handleNotificationEventForTests({
      harness: "claude-code",
      event: "PermissionRequest",
      session_id: "leave-wait",
      request_id: "req-leave",
      permission_key: "req-leave",
      payload: null,
    });

    // The session resolved its waiting state — either the user answered
    // in the TUI or the harness moved on. The OS Notification Center
    // entry should be dismissed alongside the in-memory permission key.
    __handleAgentStateChangedForTests({
      session_id: "leave-wait",
      harness: "claude-code",
      from: "waiting",
      to: "working",
    });

    const clears = clearCalls();
    expect(clears).toHaveLength(1);
    expect(clears[0]).toEqual({ sessionId: "leave-wait", kinds: ["needs_input"] });
  });

  it("dismisses needs_input OS notifications when the session is removed", async () => {
    await __handleNotificationEventForTests({
      harness: "codex",
      event: "PermissionRequest",
      session_id: "rm-target",
      permission_key: "rm-target",
      payload: null,
    });

    __handleSessionRemovedForTests("rm-target");

    const clears = clearCalls();
    expect(clears).toHaveLength(1);
    expect(clears[0]).toEqual({ sessionId: "rm-target", kinds: ["needs_input"] });
  });

  it("forwards notifications:clicked events as terminal-focus-requested", async () => {
    // Pre-populate `notifications_check_authorization` so `startNotificationCenter` resolves.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "notifications_check_authorization") {
        return {
          status: "granted",
          bundle_id: "de.raum.desktop",
          is_dev_mode: false,
          note: null,
        };
      }
      if (cmd === "config_get") {
        return { notifications: {} };
      }
      return undefined;
    });

    const dispose = await startNotificationCenter();
    const handler = listenHandlers.get("notifications:clicked");
    expect(handler).toBeDefined();

    const seen: string[] = [];
    const dom = (ev: Event) => {
      const detail = (ev as CustomEvent<{ sessionId: string }>).detail;
      seen.push(detail.sessionId);
    };
    window.addEventListener("terminal-focus-requested", dom);

    handler!({ payload: { sessionId: "click-target" } });
    expect(seen).toEqual(["click-target"]);

    window.removeEventListener("terminal-focus-requested", dom);
    dispose();
  });
});
