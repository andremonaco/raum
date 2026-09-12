# Terminal presentation

Warm residency is enabled by default for new and existing installations. Inactive
terminal surfaces use `display: none` while their mounted terminals continue
processing output. Recently hidden renderers are retained briefly for quick returns.
The existing limits remain: eight WebGL contexts, four warm-hidden panes, a
384 MiB estimated presentation budget used to reclaim hidden renderers, and a
four-second warm reclamation timer. The byte estimate is not a hard process-memory
limit.

## Production observation

On macOS with raum 0.1.21, 38 saved sessions across ten projects, switching with
the legacy policy took 1,311–3,071 ms across eight recorded project clicks
(median 2,429.5 ms). The first seven clicks after the warm-policy restart took
63–199 ms (median 101 ms), and the user confirmed switching felt instant.

These are click-to-double-animation-frame measurements from September 12, 2026,
not controlled input-to-terminal-render acceptance results. The warm samples
overlap startup restoration. Linux validation, long-duration memory checks and
the full stress matrix remain outstanding.

## Rollback

In the app's webview console, set the explicit override and restart raum:

```js
localStorage.setItem("raum:presentation-policy", "legacy");
```

To restore the default, remove the override and restart:

```js
localStorage.removeItem("raum:presentation-policy");
```

Release navigation diagnostics remain opt-in via
`localStorage.setItem("raum:navigation-diagnostics", "1")` followed by a restart.
