import type { GeoBounds } from '../geo/tiles';
import type { BuiltTerrainMesh } from './buildMesh';
import type { TerrainProvider } from './provider';
import type {
  ImageryRequest,
  ImageryWorkerResponse,
  TerrainDecodeRequest,
  TerrainWorkerResponse,
} from './workerTypes';

interface TerrainQueueItem {
  key: string;
  z: number;
  x: number;
  y: number;
  bounds: GeoBounds;
  priority: number;
}

interface TerrainActive {
  key: string;
  timer: ReturnType<typeof setTimeout>;
}

interface ImageryQueueItem {
  key: string;
  bounds: GeoBounds;
  z: number;
  priority: number;
}

interface ImageryActive {
  key: string;
  timer: ReturnType<typeof setTimeout>;
}

const TERRAIN_WORKERS = 2;
const TERRAIN_CONCURRENCY = 6;
const IMAGERY_CONCURRENCY = 5;

export class TerrainLoader {
  private workers: Worker[] = [];
  private nextWorker = 0;
  private queue: TerrainQueueItem[] = [];
  private queued = new Set<string>();
  private active = new Map<number, TerrainActive>();
  private activeKeys = new Set<string>();
  private inFlight = 0;
  private nextId = 1;
  private disposed = false;

  constructor(
    private readonly provider: TerrainProvider,
    private readonly origin: { lon: number; lat: number; height: number },
    private readonly onDecoded: (key: string, mesh: BuiltTerrainMesh) => void,
    private readonly onError: (key: string, message: string) => void,
  ) {
    for (let i = 0; i < TERRAIN_WORKERS; i++) {
      const worker = new Worker(
        new URL('../workers/terrain.worker.ts', import.meta.url),
        { type: 'module', name: `terrain-${i}` },
      );
      worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) =>
        this.handleMessage(event.data);
      worker.onerror = (event) => {
        console.error('[terrain] worker error', event.message);
      };
      this.workers.push(worker);
    }
  }

  get pendingCount(): number {
    return this.inFlight + this.queue.length;
  }

  enqueue(
    key: string,
    z: number,
    x: number,
    y: number,
    bounds: GeoBounds,
    priority: number,
  ) {
    if (this.disposed) return;
    if (this.queued.has(key) || this.activeKeys.has(key)) return;
    this.queue.push({ key, z, x, y, bounds, priority });
    this.queued.add(key);
    this.pump();
  }

  private pump() {
    if (this.disposed) return;

    while (this.inFlight < TERRAIN_CONCURRENCY && this.queue.length > 0) {
      this.queue.sort((a, b) => b.priority - a.priority);
      const item = this.queue.shift();
      if (!item) break;

      this.queued.delete(item.key);
      this.activeKeys.add(item.key);
      this.inFlight++;

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.fail(id, 'Terrain tile timeout');
      }, 40_000);
      this.active.set(id, { key: item.key, timer });

      const request: TerrainDecodeRequest = {
        type: 'decode',
        id,
        url: this.provider.tileUrl(item.z, item.x, item.y),
        bounds: item.bounds,
        z: item.z,
        origin: this.origin,
      };

      const worker = this.workers[this.nextWorker++ % this.workers.length];
      worker.postMessage(request);
    }
  }

  private handleMessage(message: TerrainWorkerResponse) {
    const entry = this.active.get(message.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.active.delete(message.id);
    this.activeKeys.delete(entry.key);
    this.inFlight--;

    if (message.type === 'decoded') {
      this.onDecoded(entry.key, message.mesh);
    } else {
      this.onError(entry.key, message.message);
    }

    this.pump();
  }

  private fail(id: number, reason: string) {
    const entry = this.active.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.active.delete(id);
    this.activeKeys.delete(entry.key);
    this.inFlight--;
    this.onError(entry.key, reason);
    this.pump();
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.active.values()) clearTimeout(timer.timer);
    this.active.clear();
    this.activeKeys.clear();
    this.queued.clear();
    this.queue.length = 0;
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
  }
}

export class ImageryLoader {
  private worker: Worker;
  private queue: ImageryQueueItem[] = [];
  private queued = new Set<string>();
  private active = new Map<number, ImageryActive>();
  private activeKeys = new Set<string>();
  private inFlight = 0;
  private nextId = 1;
  private disposed = false;

  constructor(
    private readonly onImage: (
      key: string,
      bitmap: ImageBitmap,
      imageryZ: number,
    ) => void,
    private readonly onError: (key: string, message: string) => void,
  ) {
    this.worker = new Worker(
      new URL('../workers/imagery.worker.ts', import.meta.url),
      { type: 'module', name: 'imagery' },
    );
    this.worker.onmessage = (event: MessageEvent<ImageryWorkerResponse>) =>
      this.handleMessage(event.data);
    this.worker.onerror = (event) => {
      console.error('[imagery] worker error', event.message);
    };
  }

  get pendingCount(): number {
    return this.inFlight + this.queue.length;
  }

  enqueue(key: string, bounds: GeoBounds, z: number, priority: number) {
    if (this.disposed) return;
    if (this.queued.has(key) || this.activeKeys.has(key)) return;
    this.queue.push({ key, bounds, z, priority });
    this.queued.add(key);
    this.pump();
  }

  private pump() {
    if (this.disposed) return;

    while (this.inFlight < IMAGERY_CONCURRENCY && this.queue.length > 0) {
      this.queue.sort((a, b) => b.priority - a.priority);
      const item = this.queue.shift();
      if (!item) break;

      this.queued.delete(item.key);
      this.activeKeys.add(item.key);
      this.inFlight++;

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.fail(id, 'Imagery timeout');
      }, 35_000);
      this.active.set(id, { key: item.key, timer });

      const request: ImageryRequest = {
        type: 'compose',
        id,
        bounds: item.bounds,
        z: item.z,
      };
      this.worker.postMessage(request);
    }
  }

  private handleMessage(message: ImageryWorkerResponse) {
    const entry = this.active.get(message.id);
    if (!entry) {
      if (message.type === 'image') message.bitmap.close();
      return;
    }

    clearTimeout(entry.timer);
    this.active.delete(message.id);
    this.activeKeys.delete(entry.key);
    this.inFlight--;

    if (message.type === 'image') {
      this.onImage(entry.key, message.bitmap, message.imageryZ);
    } else {
      this.onError(entry.key, message.message);
    }

    this.pump();
  }

  private fail(id: number, reason: string) {
    const entry = this.active.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.active.delete(id);
    this.activeKeys.delete(entry.key);
    this.inFlight--;
    this.onError(entry.key, reason);
    this.pump();
  }

  dispose() {
    this.disposed = true;
    for (const timer of this.active.values()) clearTimeout(timer.timer);
    this.active.clear();
    this.activeKeys.clear();
    this.queued.clear();
    this.queue.length = 0;
    this.worker.terminate();
  }
}
