/**
 * File editor modal powered by CodeMirror 6.
 *
 * Opened from the spotlight dock when the user selects a file result.
 * Reads the file via the `file_read` Tauri command, lets the user edit it in a
 * full CodeMirror editor, and saves back with `file_write` on ⌘S or the Save
 * button. Language support is auto-detected from the file extension.
 *
 * Designed as a foundation for a future git-diff view (same modal, different
 * CodeMirror extension set).
 */

import { Component, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";

// CodeMirror 6 core
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";

// Languages
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";

import { Button } from "./ui/button";
import { loadCodeMirrorTheme } from "../lib/theme/cmTheme";
import { tildify } from "../lib/pathDisplay";
import { getCurrentTheme, subscribeThemeChange } from "../lib/theme/themeController";

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

function getLanguageExtension(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
    case "mts":
    case "cts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "rs":
      return rust();
    case "css":
      return css();
    case "html":
    case "htm":
      return html();
    case "md":
    case "mdx":
      return markdown();
    case "json":
    case "jsonc":
      return json();
    case "py":
    case "pyw":
      return python();
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Custom CodeMirror theme overrides to blend into raum's design
// ---------------------------------------------------------------------------

const raumEditorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    fontFamily: "ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, monospace",
  },
  ".cm-scroller": {
    overflow: "auto",
    height: "100%",
  },
  // Keep oneDark's background; just override the wrapper background so there's
  // no double-border flash on load.
  "&.cm-editor": {
    background: "transparent",
  },
  ".cm-focused": {
    outline: "none",
  },
});

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FileEditorModalProps {
  open: boolean;
  path: string | null;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const FileEditorModal: Component<FileEditorModalProps> = (props) => {
  const [content, setContent] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [savedFlash, setSavedFlash] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  // CodeMirror theme extension — derived from the currently-applied raum
  // theme via `lib/theme/cmTheme.ts`. `null` until the first resolve
  // completes (the editor still mounts with CodeMirror's bare defaults so
  // the modal renders immediately on open).
  const [cmTheme, setCmTheme] = createSignal<Extension | null>(null);

  let editorContainerRef: HTMLDivElement | undefined;
  let editorView: EditorView | undefined;
  let initialContent = "";
  let flashTimer: ReturnType<typeof setTimeout> | null = null;

  // Resolve the active raum theme into a CodeMirror `Extension` (lazy-import
  // the matching `@uiw/codemirror-theme-...` package, or fall through to the
  // generic builder for BYO themes). Re-runs whenever the user picks a
  // different theme so the open editor retints in place.
  const resolveCmTheme = async (): Promise<void> => {
    const raum = getCurrentTheme();
    if (!raum) return;
    try {
      const ext = await loadCodeMirrorTheme(raum);
      setCmTheme(() => ext);
    } catch (e) {
      console.warn("[file-editor] CodeMirror theme load failed", e);
    }
  };
  void resolveCmTheme();
  const unsubscribeTheme = subscribeThemeChange(() => {
    void resolveCmTheme();
  });

  // Load file when path changes
  createEffect(() => {
    const path = props.path;
    if (!path || !props.open) return;
    setError(null);
    setLoading(true);
    setDirty(false);
    invoke<string>("file_read", { path })
      .then((text) => {
        initialContent = text;
        setContent(text);
        setLoading(false);
      })
      .catch((e: unknown) => {
        setError(String(e));
        setLoading(false);
      });
  });

  // Build/rebuild CodeMirror when content is loaded, container is ready, or
  // the resolved theme changes. Also re-runs when the user switches to a
  // different VSCode theme so the editor retints without unmounting.
  createEffect(() => {
    if (!props.open || loading() || !editorContainerRef) return;
    const path = props.path ?? "";
    const text = content();
    const themeExt = cmTheme();

    // Destroy previous instance
    if (editorView) {
      editorView.destroy();
      editorView = undefined;
    }

    const langExt = getLanguageExtension(path);
    const extensions: Extension[] = [
      basicSetup,
      keymap.of([...defaultKeymap, ...historyKeymap]),
      raumEditorTheme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          setDirty(update.state.doc.toString() !== initialContent);
        }
      }),
    ];
    if (themeExt) extensions.push(themeExt);
    if (langExt) extensions.push(langExt);

    editorView = new EditorView({
      state: EditorState.create({ doc: text, extensions }),
      parent: editorContainerRef,
    });
  });

  onCleanup(() => {
    unsubscribeTheme();
    editorView?.destroy();
    editorView = undefined;
    if (flashTimer !== null) clearTimeout(flashTimer);
  });

  async function save(): Promise<void> {
    const path = props.path;
    if (!path || !editorView) return;
    setSaving(true);
    setError(null);
    const text = editorView.state.doc.toString();
    try {
      await invoke("file_write", { path, content: text });
      initialContent = text;
      setDirty(false);
      setSavedFlash(true);
      if (flashTimer !== null) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => setSavedFlash(false), 1800);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      void save();
    }
    if (e.key === "Escape" && !dirty()) {
      e.preventDefault();
      props.onClose();
    }
  }

  // Filename from path for display
  const fileName = () => props.path?.split("/").pop() ?? "";
  const dirPath = () => {
    const p = props.path ?? "";
    const last = p.lastIndexOf("/");
    return last >= 0 ? p.slice(0, last) : p;
  };

  return (
    <Show when={props.open && props.path}>
      <Portal>
        {/* Backdrop */}
        <div
          class="fixed inset-0 z-[60] bg-scrim-strong"
          onClick={() => {
            if (!dirty()) props.onClose();
          }}
        />

        {/* Modal panel */}
        <div
          class="floating-surface animate-in fade-in zoom-in-95 duration-150 fixed inset-x-4 bottom-4 top-[6vh] z-[60] mx-auto flex max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-card"
          onKeyDown={onKeyDown}
          // Prevent backdrop click from closing when clicking panel
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-modal="true"
          aria-label={`Edit ${fileName()}`}
          // Ensure container is focusable for keydown
          tabIndex={-1}
        >
          {/* Header */}
          <header class="flex shrink-0 items-center gap-3 border-b border-border-subtle bg-surface-sunken/40 px-5 py-3">
            <FileIcon class="size-4 shrink-0 text-muted-foreground/70" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate font-mono text-xs text-foreground">{fileName()}</span>
                <Show when={dirty()}>
                  <span class="size-2 shrink-0 rounded-full bg-warning" title="Unsaved changes" />
                </Show>
              </div>
              <p class="truncate font-mono text-[10px] text-muted-foreground/50">
                {tildify(dirPath())}
              </p>
            </div>
            <button
              type="button"
              class="focus-ring rounded-md p-1.5 text-foreground-subtle transition-colors hover:bg-hover hover:text-foreground"
              onClick={() => props.onClose()}
              aria-label="Close editor"
            >
              <XIcon class="size-4" />
            </button>
          </header>

          {/* Editor body */}
          <div class="relative min-h-0 flex-1 overflow-hidden">
            <Show when={loading()}>
              <div class="absolute inset-0 flex items-center justify-center bg-card">
                <span class="text-xs text-muted-foreground/60">Loading…</span>
              </div>
            </Show>
            <Show when={error() && !loading()}>
              <div class="absolute inset-0 flex items-center justify-center bg-card">
                <span class="max-w-xs text-center text-xs text-destructive">{error()}</span>
              </div>
            </Show>
            {/* CodeMirror container — always mounted so EditorView has a stable parent */}
            <div
              ref={(el) => (editorContainerRef = el)}
              class="h-full w-full overflow-auto"
              classList={{ "opacity-0": loading() || !!error() }}
            />
          </div>

          {/* Footer */}
          <footer class="flex shrink-0 items-center gap-3 border-t border-border-subtle bg-surface-sunken/40 px-5 py-3">
            <Show when={savedFlash()}>
              <span class="animate-in fade-in text-xs text-success duration-150">Saved</span>
            </Show>
            <Show when={error()}>
              <span class="min-w-0 flex-1 truncate text-xs text-destructive">{error()}</span>
            </Show>
            <div class="ml-auto flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={props.onClose}
                class="text-muted-foreground hover:text-foreground"
              >
                {dirty() ? "Discard" : "Close"}
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => void save()}
                disabled={saving() || !dirty()}
                class="gap-1.5"
              >
                <Show
                  when={saving()}
                  fallback={
                    <>
                      Save <Kbd>⌘S</Kbd>
                    </>
                  }
                >
                  Saving…
                </Show>
              </Button>
            </div>
          </footer>
        </div>
      </Portal>
    </Show>
  );
};

// ---------------------------------------------------------------------------
// Inline icon sub-components
// ---------------------------------------------------------------------------

function FileIcon(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function XIcon(props: { class?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={props.class}
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function Kbd(props: { children: string }) {
  return (
    <kbd class="rounded border border-current/20 bg-current/10 px-1 py-0.5 font-mono text-[10px] font-normal">
      {props.children}
    </kbd>
  );
}

export default FileEditorModal;
