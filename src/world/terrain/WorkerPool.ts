import type { TileJob, TileOutput, WorkerRequest, WorkerResponse } from './protocol';

export type JobResult =
  | { ok: true; result: TileOutput }
  | { ok: false; reason: 'absent' | 'cancelled' | 'error'; error?: string };

interface Job {
  id: number;
  job: TileJob;
  priority: number;
  worker: number;
  done: (r: JobResult) => void;
}

export interface JobHandle {
  /** Stops the job: drops it from the queue, or aborts its downloads if it already runs. */
  cancel(): void;
  setPriority(p: number): void;
}

/**
 * A few identical tile workers with a priority queue. The cap on jobs in flight is also the
 * network limit, since every job starts with downloads (fair use of swisstopo's servers).
 */
export class WorkerPool {
  private readonly workers: Worker[] = [];
  private readonly load: number[] = [];
  private readonly queue: Job[] = [];
  private readonly running = new Map<number, Job>();
  private nextId = 1;

  constructor(
    factory: () => Worker,
    size: number,
    private maxInFlight: number,
  ) {
    for (let i = 0; i < size; i++) {
      const w = factory();
      w.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
      this.workers.push(w);
      this.load.push(0);
    }
  }

  /** Jobs running at the same time; raising it starts waiting jobs at once. */
  set limit(n: number) {
    if (n === this.maxInFlight) return;
    this.maxInFlight = n;
    this.pump();
  }

  get queued() {
    return this.queue.length;
  }

  get inFlight() {
    return this.running.size;
  }

  submit(job: TileJob, priority: number, done: (r: JobResult) => void): JobHandle {
    const entry: Job = { id: this.nextId++, job, priority, worker: -1, done };
    this.queue.push(entry);
    this.pump();
    return {
      cancel: () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) {
          this.queue.splice(i, 1);
          return;
        }
        if (this.running.has(entry.id)) {
          const msg: WorkerRequest = { type: 'cancel', id: entry.id };
          this.workers[entry.worker]!.postMessage(msg);
        }
      },
      setPriority: (p) => {
        entry.priority = p;
      },
    };
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.queue.length = 0;
    this.running.clear();
  }

  private pump() {
    while (this.running.size < this.maxInFlight && this.queue.length > 0) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++)
        if (this.queue[i]!.priority > this.queue[best]!.priority) best = i;
      const job = this.queue.splice(best, 1)[0]!;
      let w = 0;
      for (let i = 1; i < this.workers.length; i++) if (this.load[i]! < this.load[w]!) w = i;
      job.worker = w;
      this.load[w]!++;
      this.running.set(job.id, job);
      const msg: WorkerRequest = { type: 'build', id: job.id, job: job.job };
      this.workers[w]!.postMessage(msg);
    }
  }

  private onMessage(msg: WorkerResponse) {
    const job = this.running.get(msg.id);
    if (!job) {
      if (msg.ok) msg.result.image.close();
      return;
    }
    this.running.delete(msg.id);
    this.load[job.worker]!--;
    if (msg.ok) job.done({ ok: true, result: msg.result });
    else job.done({ ok: false, reason: msg.reason, error: msg.error });
    this.pump();
  }
}
