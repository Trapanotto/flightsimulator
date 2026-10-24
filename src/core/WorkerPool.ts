import type { WorkerRequest, WorkerResponse } from '../terrain/workerTypes';

interface Pending<J, R> {
  id: number;
  job: J;
  priority: number;
  resolve: (r: R) => void;
  reject: (e: Error) => void;
}

export interface JobHandle<R> {
  promise: Promise<R>;
  /** Removes the job if it has not started yet. */
  cancel(): void;
  /** Higher runs first. Can be changed while queued. */
  setPriority(p: number): void;
}

/**
 * Small pool of identical workers with a priority queue and a cap on jobs in flight.
 * The cap doubles as our network limit, since every job starts with a download.
 */
export class WorkerPool<J, R> {
  private readonly workers: Worker[] = [];
  private readonly busy: number[] = [];
  private readonly queue: Pending<J, R>[] = [];
  private readonly running = new Map<number, { pending: Pending<J, R>; worker: number }>();
  private nextId = 1;

  constructor(
    factory: () => Worker,
    size: number,
    private readonly maxInFlight: number,
  ) {
    for (let i = 0; i < size; i++) {
      const w = factory();
      w.onmessage = (e: MessageEvent<WorkerResponse<R>>) => this.onMessage(e.data);
      this.workers.push(w);
      this.busy.push(0);
    }
  }

  get queued() {
    return this.queue.length;
  }

  get inFlight() {
    return this.running.size;
  }

  submit(job: J, priority = 0): JobHandle<R> {
    let pending!: Pending<J, R>;
    const promise = new Promise<R>((resolve, reject) => {
      pending = { id: this.nextId++, job, priority, resolve, reject };
    });
    this.queue.push(pending);
    this.pump();
    return {
      promise,
      cancel: () => {
        const i = this.queue.indexOf(pending);
        if (i >= 0) {
          this.queue.splice(i, 1);
          pending.reject(new Error('cancelled'));
        }
      },
      setPriority: (p) => {
        pending.priority = p;
      },
    };
  }

  dispose() {
    this.workers.forEach((w) => w.terminate());
    this.queue.length = 0;
  }

  private pump() {
    while (this.running.size < this.maxInFlight && this.queue.length > 0) {
      // Pick the highest priority job (queue is small, a linear scan is fine).
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        if (this.queue[i]!.priority > this.queue[best]!.priority) best = i;
      }
      const p = this.queue.splice(best, 1)[0]!;
      let w = 0;
      for (let i = 1; i < this.workers.length; i++) if (this.busy[i]! < this.busy[w]!) w = i;
      this.busy[w]!++;
      this.running.set(p.id, { pending: p, worker: w });
      const msg: WorkerRequest<J> = { id: p.id, job: p.job };
      this.workers[w]!.postMessage(msg);
    }
  }

  private onMessage(msg: WorkerResponse<R>) {
    const run = this.running.get(msg.id);
    if (!run) return;
    this.running.delete(msg.id);
    this.busy[run.worker]!--;
    if (msg.ok) run.pending.resolve(msg.result);
    else run.pending.reject(new Error(msg.error));
    this.pump();
  }
}
