import type { BuildingJob, JobOutput, WorkerRequest, WorkerResponse } from './protocol';

export type JobResult =
  | { ok: true; output: JobOutput }
  | { ok: false; reason: 'absent' | 'cancelled' | 'error'; error?: string };

export interface JobHandle {
  cancel(): void;
  setPriority(p: number): void;
}

interface Entry {
  id: number;
  job: BuildingJob;
  priority: number;
  worker: number;
  done: (r: JobResult) => void;
}

/**
 * A few building workers behind a priority queue (lowest priority value first: the distance).
 * The cap on jobs in flight is also the network limit towards swisstopo.
 */
export class BuildingWorkers {
  private readonly workers: Worker[] = [];
  private readonly load: number[] = [];
  private readonly queue: Entry[] = [];
  private readonly running = new Map<number, Entry>();
  private nextId = 1;

  constructor(
    factory: () => Worker,
    size: number,
    private readonly maxInFlight: number,
  ) {
    for (let i = 0; i < size; i++) {
      const w = factory();
      w.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data);
      w.onerror = (e) => console.warn('buildings: worker error', e.message);
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

  submit(job: BuildingJob, priority: number, done: (r: JobResult) => void): JobHandle {
    const entry: Entry = { id: this.nextId++, job, priority, worker: -1, done };
    this.queue.push(entry);
    this.pump();
    return {
      cancel: () => {
        const i = this.queue.indexOf(entry);
        if (i >= 0) {
          this.queue.splice(i, 1);
          entry.done({ ok: false, reason: 'cancelled' });
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
    while (this.running.size < this.maxInFlight && this.queue.length) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++)
        if (this.queue[i]!.priority < this.queue[best]!.priority) best = i;
      const entry = this.queue.splice(best, 1)[0]!;
      let w = 0;
      for (let i = 1; i < this.load.length; i++) if (this.load[i]! < this.load[w]!) w = i;
      entry.worker = w;
      this.load[w]!++;
      this.running.set(entry.id, entry);
      const msg: WorkerRequest = { type: 'job', id: entry.id, job: entry.job };
      this.workers[w]!.postMessage(msg);
    }
  }

  private onMessage(msg: WorkerResponse) {
    const entry = this.running.get(msg.id);
    if (!entry) return;
    this.running.delete(msg.id);
    this.load[entry.worker]!--;
    if (msg.type === 'done') entry.done({ ok: true, output: msg.output });
    else entry.done({ ok: false, reason: msg.reason, error: msg.error });
    this.pump();
  }
}
