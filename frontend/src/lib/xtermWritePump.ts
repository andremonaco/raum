export interface TerminalOutputWriter {
  reset(): void;
  write(data: Uint8Array, callback: () => void): void;
}

export interface XtermWritePump {
  generation(): number;
  rotate(resetOnFirstOutput: boolean): number;
  enqueue(generation: number, bytes: Uint8Array): void;
  queuedFrames(): number;
}

export interface XtermWritePumpOptions {
  getTerminal: () => TerminalOutputWriter | null;
  onWriteParsed?: () => void;
  onWarn?: (queuedFrames: number) => void;
  warnAtFrames?: number;
  coalesceBytes?: number;
}

export function createXtermWritePump(options: XtermWritePumpOptions): XtermWritePump {
  const warnAtFrames = options.warnAtFrames ?? 256;
  const coalesceBytes = options.coalesceBytes ?? 256 * 1024;
  let outputGeneration = 0;
  let resetOnFirstOutputGeneration: number | null = null;
  let writePumpActive = false;
  let writeQueue: Array<{ generation: number; bytes: Uint8Array }> = [];

  const coalesceNextFrame = (): { generation: number; bytes: Uint8Array } | null => {
    while (writeQueue.length > 0 && writeQueue[0].generation !== outputGeneration) {
      writeQueue.shift();
    }
    const first = writeQueue.shift();
    if (!first) return null;
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
      merged.set(frame.bytes, offset);
      offset += frame.bytes.byteLength;
    }
    return { generation: first.generation, bytes: merged };
  };

  const pump = (): void => {
    if (writePumpActive) return;
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
    try {
      terminal.write(frame.bytes, () => {
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
      return outputGeneration;
    },
    enqueue(generation: number, bytes: Uint8Array): void {
      if (generation !== outputGeneration) return;
      writeQueue.push({ generation, bytes });
      if (writeQueue.length === warnAtFrames) {
        options.onWarn?.(writeQueue.length);
      }
      pump();
    },
    queuedFrames: () => writeQueue.length,
  };
}
