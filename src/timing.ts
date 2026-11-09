// Hidden tabs throttle timers to about one second, and a background editor can
// be hidden. Short waits there yield through a MessageChannel, which is not
// throttled, so React and the data stores keep running between checks.
export function pause(ms: number): Promise<void> {
  if (document.visibilityState !== 'hidden') {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  const until = Date.now() + ms;
  const channel = new MessageChannel();

  return new Promise<void>((resolve) => {
    channel.port1.onmessage = () => {
      if (Date.now() >= until) {
        channel.port1.close();
        resolve();
      } else {
        channel.port2.postMessage(null);
      }
    };

    channel.port2.postMessage(null);
  });
}

// The invoker abandons a page call after 45 seconds. Waits and requests in
// one operation share this end and leave time to roll back or report.
let operationEnd = Number.POSITIVE_INFINITY;

export function startOperation(): void {
  operationEnd = Date.now() + 38000;
}

export function remainingMs(): number {
  return operationEnd - Date.now();
}

// Native initialization can be slow without being stuck: a busy desktop editor
// renders each block in a few hundred milliseconds. Each finished block resets
// the stall timer. An edit fails after stallMs without progress, or at capMs.
export class Budget {
  readonly started = Date.now();
  private last = this.started;

  constructor(
    readonly stallMs: number,
    readonly capMs: number,
  ) {}

  progress(): void {
    this.last = Date.now();
  }

  get deadline(): number {
    return Math.min(this.started + this.capMs, this.last + this.stallMs);
  }

  diagnostics() {
    return {
      stall_ms: this.stallMs,
      cap_ms: this.capMs,
      elapsed_ms: Date.now() - this.started,
      document_hidden: document.visibilityState === 'hidden',
    };
  }
}

export type Deadline = number | Budget;

export function limit(deadline: Deadline): number {
  return deadline instanceof Budget ? deadline.deadline : deadline;
}
