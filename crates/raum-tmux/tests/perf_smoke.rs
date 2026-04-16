//! §3.5 — perf smoke test. Pumps ~10 MB through the coalescer end-to-end and
//! asserts p99 chunk delivery latency under 30 ms.
//!
//! `#[ignore]`-by-default: the test is run on CI with `--ignored` on macOS /
//! Linux runners. Windows baseline is known to sit above 100 ms for binary
//! Channel payloads; treating Windows > 100 ms as a platform follow-up — see
//! design.md D24.

#![allow(clippy::cast_precision_loss)]

use std::time::{Duration, Instant};

use bytes::Bytes;
use raum_tmux::{COALESCE_BYTES, Coalescer};
use tokio::sync::mpsc;

const TOTAL_BYTES: usize = 10 * 1024 * 1024; // 10 MB
const CHUNK_BYTES: usize = 4 * 1024; // 4 KB producer chunks
const P99_BUDGET_MS: u64 = 30;

fn quantiles_index(sorted_len: usize, q: f64) -> usize {
    // Nearest-rank quantile; bounded to the last valid index.
    let idx = ((sorted_len as f64) * q).ceil() as usize;
    idx.saturating_sub(1).min(sorted_len.saturating_sub(1))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "perf-smoke: run explicitly with `cargo test --release -- --ignored`"]
async fn coalescer_p99_under_budget_macos() {
    let (src_tx, src_rx) = mpsc::channel::<Bytes>(256);
    let (out_tx, mut out_rx) = mpsc::channel::<Bytes>(256);
    let coal = Coalescer::new(src_rx, out_tx);
    let coal_handle = tokio::spawn(coal.run());

    // Consumer: record (bytes-received, elapsed-since-producer-start) for every
    // coalesced chunk, so we can compute per-chunk delivery latency.
    let start = Instant::now();
    let consumer_start = start;
    let consumer = tokio::spawn(async move {
        let mut latencies = Vec::with_capacity(1024);
        let mut received = 0usize;
        while let Some(chunk) = out_rx.recv().await {
            let now = consumer_start.elapsed();
            received += chunk.len();
            latencies.push(now);
            if received >= TOTAL_BYTES {
                break;
            }
        }
        (received, latencies)
    });

    // Producer: send 10 MB in 4 KB chunks as fast as the mpsc lets us.
    // Re-use a single `Bytes` so we don't pay for a fresh allocation per chunk —
    // `Bytes::clone` is a cheap atomic ref-count bump.
    let payload: Bytes = Bytes::from(vec![b'x'; CHUNK_BYTES]);
    let mut sent_at = Vec::with_capacity(TOTAL_BYTES / CHUNK_BYTES);
    let mut sent = 0usize;
    while sent < TOTAL_BYTES {
        let ts = start.elapsed();
        src_tx.send(payload.clone()).await.expect("send");
        sent_at.push((sent, ts));
        sent += CHUNK_BYTES;
    }
    drop(src_tx); // end of stream

    let (received, latencies) = consumer.await.expect("consumer");
    coal_handle.await.expect("coalescer shutdown");
    assert!(received >= TOTAL_BYTES, "consumer drained the full payload");

    // Compute per-chunk delivery latency as the gap between each output-chunk
    // timestamp and the matching producer offset's timestamp.
    let mut deltas: Vec<Duration> = Vec::with_capacity(latencies.len());
    let mut cursor = 0usize; // index into sent_at
    let mut covered = 0usize; // bytes covered by the last-sent slice
    for (i, recv_ts) in latencies.iter().enumerate() {
        // Advance the producer cursor until we've sent at least
        // `(i+1) * 16KB`-worth of bytes (16 KB is the coalescer flush ceiling).
        let target = (i + 1) * COALESCE_BYTES;
        while cursor + 1 < sent_at.len() && covered < target {
            cursor += 1;
            covered = cursor * CHUNK_BYTES;
        }
        let sent_ts = sent_at[cursor].1;
        // `recv_ts >= sent_ts` is not strictly guaranteed because the clocks
        // are the same monotonic Instant, but saturate to be safe.
        deltas.push(recv_ts.saturating_sub(sent_ts));
    }

    deltas.sort();
    let p99 = deltas[quantiles_index(deltas.len(), 0.99)];
    eprintln!(
        "perf_smoke: chunks={} p50={:?} p99={:?}",
        deltas.len(),
        deltas[quantiles_index(deltas.len(), 0.50)],
        p99
    );
    assert!(
        p99 < Duration::from_millis(P99_BUDGET_MS),
        "p99 delivery latency {:?} exceeded {} ms budget",
        p99,
        P99_BUDGET_MS
    );
}
