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
pub const FLUSH_BYTES: usize = 32 * 1024;

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
