//! Stream coalescer for the PTY → IPC bridge.
//!
//! The reader thread on the tmux master fd hands us 16 KB chunks as fast as
//! the kernel produces them. Forwarding each one as its own
//! `Channel<InvokeResponseBody::Raw>` IPC event has two failure modes under
//! large bursts (e.g. a Claude Code "plan" that emits tens of KB at once):
//!
//! 1. Tauri v2 routes `Raw` payloads via two transports — inline `eval` for
//!    small payloads, custom-protocol fetch for large ones. Many back-to-back
//!    ~16 KB chunks straddle that boundary and stress the WebView's queue.
//! 2. xterm.js sees each `term.write` synchronously; a long parade of small
//!    writes blows past its internal write-buffer pacing.
//!
//! The coalescer batches consecutive reads into a size-bounded
//! ([`FLUSH_BYTES`]) or quiescence-bounded ([`QUIET_MS`], capped by
//! [`MAX_HOLD_MS`]) frame before the IPC send, so the downstream sees fewer,
//! uniformly-sized messages. It is pure logic — driven from the reader
//! pipeline by `feed`, `flush_if_due`, and `force_flush`.
//!
//! The quiescence bound exists because some TUI progress renderers (e.g.
//! `uv`, `pnpm`) redraw a multi-line block as several small, separately
//! timed writes — one cursor-move+erase+rewrite per line — instead of one
//! atomic write per frame. A blind fixed-interval flush can slice such a
//! redraw in half, forwarding a partially-updated frame that xterm.js then
//! paints, which reads as flicker/tearing even though the bytes themselves
//! are never corrupted. Waiting for a short quiet gap after the last byte
//! lets a whole redraw settle before it is shipped, while [`MAX_HOLD_MS`]
//! still bounds latency for output that never goes quiet (e.g. a busy log
//! tail).
//!
//! See `pty_bridge.rs` for the wiring.
use std::time::{Duration, Instant};

/// Size threshold: flush as soon as the buffer reaches this many bytes.
///
/// Sized to halve the number of IPC events on heavy bursts (e.g. a shell
/// pane running `pulumi up` or a tight `for` loop printing thousands of
/// lines). The quiescence/max-hold bounds below still drain small/
/// interactive output promptly, so this threshold only kicks in when the
/// producer is actually saturating the pipe.
pub const FLUSH_BYTES: usize = 128 * 1024;

/// Quiet-gap threshold (ms): flush a non-empty buffer once this much wall
/// time has elapsed since the *last byte was fed*, i.e. output has gone
/// quiet. Lets a redraw made of several back-to-back small writes settle
/// into one frame instead of being cut mid-way by a fixed timer.
pub const QUIET_MS: u64 = 4;

/// Max-hold threshold (ms): flush a non-empty buffer once this much wall
/// time has elapsed since its *first* byte, regardless of the quiet gap.
/// Bounds worst-case latency for output that never pauses long enough to
/// satisfy [`QUIET_MS`] on its own.
pub const MAX_HOLD_MS: u64 = 16;

/// Accumulates raw PTY bytes and flushes them into a single IPC frame when
/// the size threshold, the quiet gap, or the max-hold cap is reached.
#[derive(Debug)]
pub struct StreamCoalescer {
    buf: Vec<u8>,
    /// When the current batch's first byte was fed; `None` while `buf` is
    /// empty.
    first_pending: Option<Instant>,
    /// When the most recent byte was fed; drives the quiet-gap check.
    last_byte: Instant,
}

impl StreamCoalescer {
    pub fn new() -> Self {
        Self {
            // Grows into whatever the pane actually produces and is then
            // reused for the lifetime of the bridge (see `flush`), so a
            // pre-allocation would only cost idle panes memory.
            buf: Vec::new(),
            first_pending: None,
            last_byte: Instant::now(),
        }
    }

    pub fn pending(&self) -> usize {
        self.buf.len()
    }

    /// The instant a pending batch becomes flushable — the earlier of the
    /// quiet gap and the max-hold cap — or `None` when nothing is buffered.
    /// Lets the drain loop sleep exactly to the deadline instead of polling.
    fn flush_deadline(&self) -> Option<Instant> {
        if self.buf.is_empty() {
            return None;
        }
        let quiet = self.last_byte + Duration::from_millis(QUIET_MS);
        let cap = self
            .first_pending
            .map(|t| t + Duration::from_millis(MAX_HOLD_MS));
        Some(cap.map_or(quiet, |cap| cap.min(quiet)))
    }

    /// Append `chunk`, then flush if the buffer is at or above
    /// [`FLUSH_BYTES`]. Returns `false` when `sink` rejects (the caller
    /// should stop feeding and tear down).
    pub fn feed<F>(&mut self, chunk: &[u8], sink: &mut F) -> bool
    where
        F: FnMut(Vec<u8>) -> bool,
    {
        self.feed_at(chunk, Instant::now(), sink)
    }

    /// [`Self::feed`] with an injected clock — the timing tests drive the
    /// quiet-gap / max-hold semantics with synthetic instants so they are
    /// deterministic under CI load instead of racing `thread::sleep`.
    fn feed_at<F>(&mut self, chunk: &[u8], now: Instant, sink: &mut F) -> bool
    where
        F: FnMut(Vec<u8>) -> bool,
    {
        if chunk.is_empty() {
            return true;
        }
        if self.buf.is_empty() {
            self.first_pending = Some(now);
        }
        self.last_byte = now;
        self.buf.extend_from_slice(chunk);
        if self.buf.len() >= FLUSH_BYTES {
            return self.flush(sink);
        }
        true
    }

    /// Flush if the buffer is non-empty and either the quiet gap
    /// ([`QUIET_MS`] since the last byte) or the max-hold cap
    /// ([`MAX_HOLD_MS`] since the first byte of this batch) has elapsed.
    /// Driven from the consumer side between reads so a burst that stops
    /// below [`FLUSH_BYTES`] doesn't get stranded.
    pub fn flush_if_due<F>(&mut self, sink: &mut F) -> bool
    where
        F: FnMut(Vec<u8>) -> bool,
    {
        self.flush_if_due_at(Instant::now(), sink)
    }

    /// [`Self::flush_if_due`] with an injected clock; see [`Self::feed_at`].
    fn flush_if_due_at<F>(&mut self, now: Instant, sink: &mut F) -> bool
    where
        F: FnMut(Vec<u8>) -> bool,
    {
        if self.buf.is_empty() {
            return true;
        }
        let quiet =
            now.saturating_duration_since(self.last_byte) >= Duration::from_millis(QUIET_MS);
        let held_too_long = self.first_pending.is_some_and(|t| {
            now.saturating_duration_since(t) >= Duration::from_millis(MAX_HOLD_MS)
        });
        if quiet || held_too_long {
            self.flush(sink)
        } else {
            true
        }
    }

    /// Flush whatever is buffered regardless of thresholds. Used on EOF /
    /// shutdown so the tail of a final burst is not lost.
    pub fn force_flush<F>(&mut self, sink: &mut F) -> bool
    where
        F: FnMut(Vec<u8>) -> bool,
    {
        if self.buf.is_empty() {
            return true;
        }
        self.flush(sink)
    }

    fn flush<F>(&mut self, sink: &mut F) -> bool
    where
        F: FnMut(Vec<u8>) -> bool,
    {
        // Copy out an exactly-sized payload and keep the accumulator's
        // allocation. `mem::take` would hand the backing buffer to the
        // payload and force a fresh (up to `FLUSH_BYTES`-sized) allocation
        // on every single flush — hundreds per second on a busy pane.
        let payload = self.buf.clone();
        self.buf.clear();
        self.first_pending = None;
        sink(payload)
    }
}

impl Default for StreamCoalescer {
    fn default() -> Self {
        Self::new()
    }
}

/// Drain a reader thread's bounded channel through a [`StreamCoalescer`]
/// into `on_data` until the channel closes or the sink rejects. Shared by
/// the PTY and control-mode bridges — both run this as the body of their
/// coalescer thread. Force-flushes the tail on channel close so the last
/// bytes of a final burst are never lost.
pub fn drain_coalesced(
    data_rx: &std::sync::mpsc::Receiver<Vec<u8>>,
    mut on_data: Box<dyn FnMut(Vec<u8>) -> bool + Send>,
) {
    use std::sync::mpsc::RecvTimeoutError;

    // Re-borrow the boxed sink instead of wrapping it in another closure —
    // `&mut dyn FnMut` is itself `FnMut`, so the coalescer calls through one
    // indirection instead of two.
    let mut sink = &mut *on_data;
    let mut coalescer = StreamCoalescer::new();
    loop {
        // With nothing buffered there is no deadline to service, so block
        // instead of polling: an idle pane costs zero wakeups rather than
        // 1000/QUIET_MS per second. A pending batch waits exactly to its own
        // flush deadline — one wakeup per batch, and max-hold is honoured to
        // the millisecond instead of overshooting by up to a poll interval.
        let chunk = match coalescer.flush_deadline() {
            None => match data_rx.recv() {
                Ok(chunk) => chunk,
                // Disconnected with an empty buffer — nothing to flush.
                Err(_) => break,
            },
            Some(deadline) => {
                let wait = deadline.saturating_duration_since(Instant::now());
                match data_rx.recv_timeout(wait) {
                    Ok(chunk) => chunk,
                    Err(RecvTimeoutError::Timeout) => {
                        if !coalescer.flush_if_due(&mut sink) {
                            break;
                        }
                        continue;
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        let _ = coalescer.force_flush(&mut sink);
                        break;
                    }
                }
            }
        };
        // One clock read per iteration, shared by the feed and the due check
        // (they measure the same instant anyway).
        let now = Instant::now();
        if !coalescer.feed_at(&chunk, now, &mut sink) {
            break;
        }
        if !coalescer.flush_if_due_at(now, &mut sink) {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::thread;
    use std::time::Duration;

    use super::*;

    fn collect_sink(out: &RefCell<Vec<Vec<u8>>>) -> impl FnMut(Vec<u8>) -> bool + '_ {
        move |bytes| {
            out.borrow_mut().push(bytes);
            true
        }
    }

    #[test]
    fn feed_under_threshold_does_not_flush() {
        let out = RefCell::new(Vec::new());
        let mut sink = collect_sink(&out);
        let mut c = StreamCoalescer::new();
        assert!(c.feed(&[1, 2, 3], &mut sink));
        assert_eq!(c.pending(), 3);
        assert!(out.borrow().is_empty());
    }

    #[test]
    fn feed_at_size_threshold_flushes_in_order() {
        let out = RefCell::new(Vec::new());
        let mut sink = collect_sink(&out);
        let mut c = StreamCoalescer::new();
        // Two halves so we exercise the cross-call boundary.
        let half = vec![0xAAu8; FLUSH_BYTES / 2];
        assert!(c.feed(&half, &mut sink));
        assert!(c.feed(&half, &mut sink));
        let frames = out.borrow();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].len(), FLUSH_BYTES);
        assert!(frames[0].iter().all(|&b| b == 0xAA));
    }

    /// Synthetic clock helper: `t0 + n` ms. The timing tests drive the
    /// `_at` entry points with these so they are exact under any CI load —
    /// `thread::sleep(1ms)` routinely overshoots to 4-15 ms on a loaded
    /// runner, which made the previous sleep-based versions flake in both
    /// directions (and pass without exercising the branch they named).
    fn at(t0: Instant, ms: u64) -> Instant {
        t0 + Duration::from_millis(ms)
    }

    #[test]
    fn flush_deadline_tracks_the_earlier_of_quiet_gap_and_max_hold() {
        let out = RefCell::new(Vec::new());
        let mut sink = collect_sink(&out);
        let mut c = StreamCoalescer::new();
        assert_eq!(c.flush_deadline(), None, "idle: nothing to wait for");
        let t0 = Instant::now();
        c.feed_at(b"a", t0, &mut sink);
        // Fresh batch: the quiet gap is the nearer deadline.
        assert_eq!(c.flush_deadline(), Some(at(t0, QUIET_MS)));
        // Kept fed past MAX_HOLD - QUIET: the cap becomes the nearer one, so
        // the drain loop can't sleep past it.
        c.feed_at(b"b", at(t0, MAX_HOLD_MS - 1), &mut sink);
        assert_eq!(c.flush_deadline(), Some(at(t0, MAX_HOLD_MS)));
        c.force_flush(&mut sink);
        assert_eq!(c.flush_deadline(), None, "drained: back to blocking recv");
    }

    #[test]
    fn flush_if_due_waits_for_quiet_gap() {
        let out = RefCell::new(Vec::new());
        let mut sink = collect_sink(&out);
        let mut c = StreamCoalescer::new();
        let t0 = Instant::now();
        c.feed_at(b"hello", t0, &mut sink);
        // Same instant as the feed — no flush yet.
        c.flush_if_due_at(t0, &mut sink);
        assert!(out.borrow().is_empty());
        // One tick short of the gap — still pending.
        c.flush_if_due_at(at(t0, QUIET_MS - 1), &mut sink);
        assert!(out.borrow().is_empty());
        c.flush_if_due_at(at(t0, QUIET_MS), &mut sink);
        assert_eq!(out.borrow().as_slice(), &[b"hello".to_vec()]);
    }

    #[test]
    fn flush_if_due_holds_through_repeated_bytes_within_quiet_gap() {
        // Regression for the flicker fix: several small writes arriving a
        // few ms apart (a redraw split across writes) must settle into ONE
        // frame, not get sliced by a check firing between them. The feeds
        // deliberately span 10 ms — past the pre-fix implementation's fixed
        // 8 ms since-last-flush threshold — so this test FAILS against the
        // old semantics instead of passing vacuously.
        let out = RefCell::new(Vec::new());
        let mut sink = collect_sink(&out);
        let mut c = StreamCoalescer::new();
        let t0 = Instant::now();
        for step in 0..6u64 {
            let now = at(t0, step * 2); // 0,2,4,…,10 ms — gaps below QUIET_MS
            c.feed_at(b"line", now, &mut sink);
            c.flush_if_due_at(now, &mut sink);
            c.flush_if_due_at(at(t0, step * 2 + 1), &mut sink);
        }
        assert!(
            out.borrow().is_empty(),
            "quiet gap kept resetting; batch should still be pending"
        );
        // Last byte at 10 ms → quiet at 14 ms, still under MAX_HOLD (16 ms).
        c.flush_if_due_at(at(t0, 10 + QUIET_MS), &mut sink);
        assert_eq!(out.borrow().as_slice(), &[b"line".repeat(6)]);
    }

    #[test]
    fn flush_if_due_caps_latency_at_max_hold_even_if_never_quiet() {
        // A producer that keeps writing faster than the quiet gap (e.g. a
        // continuous log tail) must still be flushed within MAX_HOLD_MS so
        // latency stays bounded — and via the max-hold branch specifically:
        // every check below runs at a feed instant, where the quiet gap is
        // zero by construction, so only max-hold can fire.
        let out = RefCell::new(Vec::new());
        let mut sink = collect_sink(&out);
        let mut c = StreamCoalescer::new();
        let t0 = Instant::now();
        let mut flushed_at_ms = None;
        for step in 0..12u64 {
            let ms = step * 2; // 0,2,4,…,22 ms — never quiet
            let now = at(t0, ms);
            c.feed_at(b"x", now, &mut sink);
            c.flush_if_due_at(now, &mut sink);
            if !out.borrow().is_empty() {
                flushed_at_ms = Some(ms);
                break;
            }
        }
        // First feed instant at or past the cap: 16 ms exactly.
        assert_eq!(
            flushed_at_ms,
            Some(MAX_HOLD_MS),
            "max-hold cap must fire at the cap"
        );
    }

    #[test]
    fn force_flush_drains_residual_buffer() {
        let out = RefCell::new(Vec::new());
        let mut sink = collect_sink(&out);
        let mut c = StreamCoalescer::new();
        c.feed(b"tail", &mut sink);
        c.force_flush(&mut sink);
        assert_eq!(out.borrow().as_slice(), &[b"tail".to_vec()]);
        // Idempotent: a second force_flush with an empty buffer is a no-op.
        c.force_flush(&mut sink);
        assert_eq!(out.borrow().len(), 1);
    }

    #[test]
    fn many_small_feeds_preserve_byte_order() {
        let out = RefCell::new(Vec::new());
        let mut sink = collect_sink(&out);
        let mut c = StreamCoalescer::new();
        let mut expected: Vec<u8> = Vec::new();
        for i in 0..10_000u32 {
            let chunk = i.to_le_bytes();
            expected.extend_from_slice(&chunk);
            c.feed(&chunk, &mut sink);
        }
        c.force_flush(&mut sink);
        let assembled: Vec<u8> = out.borrow().iter().flatten().copied().collect();
        assert_eq!(assembled, expected);
    }

    #[test]
    fn one_mb_burst_in_16kb_chunks_produces_at_most_one_flush_per_window() {
        // Regression: a 1 MB burst arriving as 16 KB reads (the PTY reader
        // upper-bounded read size before we raised it to 64 KB) should
        // coalesce into ⌈1 MB / FLUSH_BYTES⌉ size-triggered flushes — not
        // 64 individual flushes. This is what protects xterm.js / the
        // WebView from a parade of small writes during heavy bursts.
        let out = RefCell::new(Vec::new());
        let mut sink = collect_sink(&out);
        let mut c = StreamCoalescer::new();
        const CHUNK: usize = 16 * 1024;
        const TOTAL: usize = 1024 * 1024;
        let chunk = vec![0xCDu8; CHUNK];
        for _ in 0..(TOTAL / CHUNK) {
            assert!(c.feed(&chunk, &mut sink));
        }
        c.force_flush(&mut sink);
        let frames = out.borrow();
        let expected_max_flushes = TOTAL.div_ceil(FLUSH_BYTES);
        assert!(
            frames.len() <= expected_max_flushes,
            "got {} flushes for a {}-byte burst with FLUSH_BYTES={}, expected ≤ {}",
            frames.len(),
            TOTAL,
            FLUSH_BYTES,
            expected_max_flushes
        );
        let assembled: usize = frames.iter().map(Vec::len).sum();
        assert_eq!(assembled, TOTAL);
    }

    #[test]
    fn feed_returns_false_when_sink_rejects() {
        let mut sink = |_bytes: Vec<u8>| false;
        let mut c = StreamCoalescer::new();
        // Push enough bytes to trigger a size-threshold flush.
        let big = vec![1u8; FLUSH_BYTES];
        assert!(!c.feed(&big, &mut sink));
    }

    #[test]
    fn flush_if_due_returns_false_when_sink_rejects() {
        let mut c = StreamCoalescer::new();
        {
            let mut accept = |_bytes: Vec<u8>| true;
            c.feed(b"x", &mut accept);
        }
        thread::sleep(Duration::from_millis(QUIET_MS + 4));
        let mut reject = |_bytes: Vec<u8>| false;
        assert!(!c.flush_if_due(&mut reject));
    }
}
