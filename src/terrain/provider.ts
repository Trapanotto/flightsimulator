const DEFAULT_TEMPLATE = '20250101/{z}/{x}/{y}.terrain?v={version}';
const DEFAULT_VERSION = '1.43646.0';
const BASE_URL = 'https://3d.geo.admin.ch/ch.swisstopo.terrain.3d/v1/';
const LAYER_URL = `${BASE_URL}layer.json`;

interface LayerJson {
  tiles?: string[];
  version?: string;
}

/**
 * Resolves the current swisstopo terrain tile template at runtime. If the
 * metadata endpoint is unavailable, the last known template is used.
 */
export class TerrainProvider {
  private template = DEFAULT_TEMPLATE;
  private version = DEFAULT_VERSION;
  private source: 'live' | 'fallback' = 'fallback';
  private ready = false;

  async init(): Promise<void> {
    try {
      const response = await fetch(LAYER_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const json = (await response.json()) as LayerJson;
      if (json.tiles?.[0]) this.template = json.tiles[0];
      if (json.version) this.version = json.version;
      this.source = 'live';
    } catch (error) {
      console.warn(
        '[terrain] layer.json unavailable, using fallback template',
        error,
      );
    }
    this.ready = true;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get isLive(): boolean {
    return this.source === 'live';
  }

  tileUrl(z: number, x: number, y: number): string {
    const path = this.template
      .replaceAll('{z}', String(z))
      .replaceAll('{x}', String(x))
      .replaceAll('{y}', String(y))
      .replaceAll('{version}', this.version);
    return `${BASE_URL}${path}`;
  }

  get attribution(): string {
    return '© swisstopo';
  }
}
