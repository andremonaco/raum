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
//! The coalescer batches consecutive reads into either a size-bounded
//! ([`FLUSH_BYTES`]) or time-bounded ([`FLUSH_MS`]) frame before the IPC
//! send, so the downstream sees fewer, uniformly-sized messages. It is pure
//! logic — driven from the reader pipeline by `feed`, `flush_if_due`, and
//! `force_flush`.
//!
//! See `pty_bridge.rs` for the wiring.
use std::time::{Duration, Instant};

/// Size threshold: flush as soon as the buffer reaches this many bytes.
///
/// Sized to halve the number of IPC events on heavy bursts (e.g. a shell
/// pane running `pulumi up` or a tight `for` loop printing thousands of
/// lines). The 8 ms time bound still drains small/interactive output
/// promptly, so this threshold only kicks in when the producer is
/// actually saturating the pipe.
pub const FLUSH_BYTES: usize = 128 * 1024;

/// Time threshold (ms): flush a non-empty buffer when this much wall time
/// has elapsed since the last flush.
pub const FLUSH_MS: u64 = 8;

/// Accumulates raw PTY bytes and flushes them into a single IPC frame when
/// either the size or the time threshold is reached.
#[derive(Debug)]
pub struct StreamCoalescer {
    buf: Vec<u8>,
    last_flush: Instant,
}

impl StreamCoalescer {
    pub fn new() -> Self {
        Self {
            buf: Vec::with_capacity(FLUSH_BYTES * 2),
            last_flush: Instant::now(),
        }
    }

    pub fn pending(&self) -> usize {
        self.buf.len()
    }

    /// Append `chunk`, then flush if the buffer is at or above
    /// [`FLUSH_BYTES`]. Returns `false` when `sink` rejects (the caller
    /// should stop feeding and tear down).
    pub fn feed<F>(&mut self, chunk: &[u8], sink: &mut F) -> bool
    where
        F: FnMut(Vec<u8>) -> bool,
    {
        if chunk.is_empty() {
            return true;
        }
        self.buf.extend_from_slice(chunk);
        if self.buf.len() >= FLUSH_BYTES {
            return self.flush(sink);
        }
        true
    }

    /// Flush if [`FLUSH_MS`] has elapsed since the last flush and the buffer
    /// is non-empty. Driven from the consumer side between reads so a burst
    /// that stops below [`FLUSH_BYTES`] doesn't get stranded.
    pub fn flush_if_due<F>(&mut self, sink: &mut F) -> bool
    where
        F: FnMut(Vec<u8>) -> bool,
    {
        if self.buf.is_empty() {
            return true;
        }
        if self.last_flush.elapsed() >= Duration::from_millis(FLUSH_MS) {
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
        let payload = std::mem::take(&mut self.buf);
        // Re-arm with a fresh buffer at the standard capacity. `mem::take`
        // leaves us with an empty `Vec` whose backing allocation is now
        // owned by `payload`, so a plain re-init is the cheapest way to
        // restore the pre-allocated capacity for the next batch.
        self.buf = Vec::with_capacity(FLUSH_BYTES * 2);
        self.last_flush = Instant::now();
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

    let mut sink = move |bytes: Vec<u8>| -> bool { on_data(bytes) };
    let mut coalescer = StreamCoalescer::new();
    let timeout = Duration::from_millis(FLUSH_MS);
    loop {
        match data_rx.recv_timeout(timeout) {
            Ok(chunk) => {
                if !coalescer.feed(&chunk, &mut sink) {
                    break;
                }
                if !coalescer.flush_if_due(&mut sink) {
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if !coalescer.flush_if_due(&mut sink) {
                    break;
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                let _ = coalescer.force_flush(&mut sink);
                break;
            }
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

    #[test]
    fn flush_if_due_waits_for_time_window() {
        let out = RefCell::new(Vec::new());
        let mut sink = collect_sink(&out);
        let mut c = StreamCoalescer::new();
        c.feed(b"hello", &mut sink);
        // Same instant as feed — no flush yet.
        c.flush_if_due(&mut sink);
        assert!(out.borrow().is_empty());
        thread::sleep(Duration::from_millis(FLUSH_MS + 4));
        c.flush_if_due(&mut sink);
        assert_eq!(out.borrow().as_slice(), &[b"hello".to_vec()]);
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
        thread::sleep(Duration::from_millis(FLUSH_MS + 4));
        let mut reject = |_bytes: Vec<u8>| false;
        assert!(!c.flush_if_due(&mut reject));
    }
}
