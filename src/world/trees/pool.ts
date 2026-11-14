import type { ChunkJob, ChunkOutput, TreeWorkerRequest, TreeWorkerResponse } from './protocol';

export type ChunkResult =
  | { ok: true; result: ChunkOutput }
  | { ok: false; reason: 'cancelled' | 'error' | 'empty'; error?: string };

interface Job {
  id: number;
  job: ChunkJob;
  priority: number;
  worker: number;
  done: (r: ChunkResult) => void;
}

export interface ChunkHandle {
  cancel(): void;
  setPriority(p: number): void;
}

/**
 * Tree workers with a priority queue (highest priority first). The cap on jobs in flight is also
 * the network limit: every job starts with downloads.
 */
export class TreeWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly load: number[] = [];
  private readonly queue: Job[] = [];
  private readonly running = new Map<number, Job>();
  private nextId = 1;

  constructor(
    factory: () => Worker,
    size: number,
    private readonly maxInFlight: number,
  ) {
    for (let i = 0; i < size; i++) {
      const w = factory();
      w.onmessage = (e: MessageEvent<TreeWorkerResponse>) => this.onMessage(e.data);
      this.workers.push(w);
      this.load.push(0);
    }
  }

  get queued() {
    return this.queue.length;
  }

  get inFlight() {
    return this.running.size;
  }

  submit(job: ChunkJob, priority: number, done: (r: ChunkResult) => void): ChunkHandle {
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
          const msg: TreeWorkerRequest = { type: 'cancel', id: entry.id };
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
      const msg: TreeWorkerRequest = { type: 'build', id: job.id, job: job.job };
      this.workers[w]!.postMessage(msg);
    }
  }

  private onMessage(msg: TreeWorkerResponse) {
    const job = this.running.get(msg.id);
    if (!job) return;
    this.running.delete(msg.id);
    this.load[job.worker]!--;
    if (msg.ok) job.done({ ok: true, result: msg.result });
    else job.done({ ok: false, reason: msg.reason, error: msg.error });
    this.pump();
  }
}
