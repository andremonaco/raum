import { countScoped } from "./navigationDiagnostics";

interface Frame {
  generation: number;
  bytes: Uint8Array;
  /** Clock reading when the frame entered the queue (queue-age counter). */
  enqueuedAt: number;
}

export interface TerminalOutputWriter {
  reset(): void;
  write(data: Uint8Array, callback: () => void): void;
}

export interface XtermWritePump {
  generation(): number;
  rotate(resetOnFirstOutput: boolean): number;
  enqueue(generation: number, bytes: Uint8Array): void;
  queuedFrames(): number;
  /** Bytes sitting in the queue (task 7.2: frames alone hide a fat backlog). */
  queuedBytes(): number;
  /** Age of the oldest queued frame in ms; 0 when the queue is empty. */
  oldestFrameAgeMs(): number;
  /** Hold frames in the queue (they keep accumulating) until `resume`. */
  pause(): void;
  resume(): void;
}

export interface XtermWritePumpOptions {
  getTerminal: () => TerminalOutputWriter | null;
  /** Injectable clock for the queue-age counter (tests pass a fake). */
  now?: () => number;
  onWriteParsed?: () => void;
  onWarn?: (queuedFrames: number) => void;
  warnAtFrames?: number;
  coalesceBytes?: number;
}

export function createXtermWritePump(options: XtermWritePumpOptions): XtermWritePump {
  const now = options.now ?? (() => performance.now());
  const warnAtFrames = options.warnAtFrames ?? 256;
  const coalesceBytes = options.coalesceBytes ?? 256 * 1024;
  let outputGeneration = 0;
  let resetOnFirstOutputGeneration: number | null = null;
  let writePumpActive = false;
  let paused = false;
  let writeQueue: Frame[] = [];
  let queuedBytes = 0;

  const drop = (frame: Frame): void => {
    queuedBytes -= frame.bytes.byteLength;
  };

  const coalesceNextFrame = (): Frame | null => {
    while (writeQueue.length > 0 && writeQueue[0].generation !== outputGeneration) {
      drop(writeQueue[0]);
      writeQueue.shift();
    }
    const first = writeQueue.shift();
    if (!first) return null;
    drop(first);
    if (first.generation !== outputGeneration) return coalesceNextFrame();

    let totalBytes = first.bytes.byteLength;
    let take = 0;
    while (
      take < writeQueue.length &&
      writeQueue[take].generation === outputGeneration &&
      totalBytes + writeQueue[take].bytes.byteLength <= coalesceBytes
    ) {
      totalBytes += writeQueue[take].bytes.byteLength;
      take += 1;
    }

    if (take === 0) return first;

    const merged = new Uint8Array(totalBytes);
    merged.set(first.bytes, 0);
    let offset = first.bytes.byteLength;
    for (const frame of writeQueue.splice(0, take)) {
      drop(frame);
      merged.set(frame.bytes, offset);
      offset += frame.bytes.byteLength;
    }
    // Oldest frame wins the timestamp: the merge must not reset queue age.
    return { generation: first.generation, bytes: merged, enqueuedAt: first.enqueuedAt };
  };

  const pump = (): void => {
    if (writePumpActive || paused) return;
    const terminal = options.getTerminal();
    if (!terminal) return;
    const frame = coalesceNextFrame();
    if (!frame) return;
    if (resetOnFirstOutputGeneration === frame.generation) {
      resetOnFirstOutputGeneration = null;
      try {
        terminal.reset();
      } catch {
        // A failed local reset should not block the replacement frame.
      }
    }
    writePumpActive = true;
    const writeStartedAt = now();
    try {
      terminal.write(frame.bytes, () => {
        countScoped("output-write", now() - writeStartedAt);
        writePumpActive = false;
        if (frame.generation === outputGeneration) {
          options.onWriteParsed?.();
        }
        pump();
      });
    } catch (err) {
      writePumpActive = false;
      pump();
      throw err;
    }
  };

  return {
    generation: () => outputGeneration,
    rotate(resetOnFirstOutput: boolean): number {
      outputGeneration += 1;
      resetOnFirstOutputGeneration = resetOnFirstOutput ? outputGeneration : null;
      writeQueue = [];
      queuedBytes = 0;
      return outputGeneration;
    },
    enqueue(generation: number, bytes: Uint8Array): void {
      if (generation !== outputGeneration) return;
      writeQueue.push({ generation, bytes, enqueuedAt: now() });
      queuedBytes += bytes.byteLength;
      if (writeQueue.length === warnAtFrames) {
        options.onWarn?.(writeQueue.length);
      }
      pump();
    },
    queuedFrames: () => writeQueue.length,
    queuedBytes: () => queuedBytes,
    oldestFrameAgeMs: () => (writeQueue.length === 0 ? 0 : now() - writeQueue[0].enqueuedAt),
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      pump();
    },
  };
}
