/**
 * Bounded concurrency for boot-time reattaches. Every persisted pane clears
 * the rehydrate gate at roughly the same instant, and each reattach costs
 * several tmux forks against a single-threaded server plus an fsync under
 * the global config lock — so N panes at once delay the one the user is
 * looking at. Priority 0 (the focused pane) bypasses the limit; visible
 * panes (1) drain before hidden/docked/other-project panes (2).
 */
export type AttachPriority = 0 | 1 | 2;

const MAX_CONCURRENT_ATTACH = 3;

let inFlight = 0;
const queue: Array<{ priority: AttachPriority; grant: (release: () => void) => void }> = [];

function makeRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight -= 1;
    pump();
  };
}

function pump(): void {
  while (inFlight < MAX_CONCURRENT_ATTACH && queue.length > 0) {
    // ponytail: linear min-scan; queue is tens of entries at boot at most.
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].priority < queue[best].priority) best = i;
    const [next] = queue.splice(best, 1);
    inFlight += 1;
    next.grant(makeRelease());
  }
}

/** Resolves with a release fn once a slot is free. Priority 0 never waits. */
export function acquireAttachSlot(priority: AttachPriority): Promise<() => void> {
  if (priority === 0) {
    inFlight += 1;
    return Promise.resolve(makeRelease());
  }
  return new Promise((grant) => {
    queue.push({ priority, grant });
    pump();
  });
}

export function __attachSchedulerStateForTests(): { inFlight: number; queued: number } {
  return { inFlight, queued: queue.length };
}
