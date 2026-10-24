import { EnuFrame } from '../geo/wgs84';
import { buildTerrainMesh } from '../terrain/buildMesh';
import { decodeQuantizedMesh } from '../terrain/quantizedMesh';
import type {
  TerrainDecodeRequest,
  TerrainWorkerResponse,
} from '../terrain/workerTypes';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<TerrainDecodeRequest>) => {
  const request = event.data;
  if (request.type !== 'decode') return;

  try {
    const response = await fetch(request.url, {
      headers: {
        Accept:
          'application/vnd.quantized-mesh;extensions=octvertexnormals,metadata',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`Terrain tile HTTP ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const decoded = decodeQuantizedMesh(buffer);
    const frame = new EnuFrame(request.origin);
    const mesh = buildTerrainMesh(decoded, request.bounds, frame);

    const message: TerrainWorkerResponse = {
      type: 'decoded',
      id: request.id,
      mesh,
    };

    scope.postMessage(message, [
      mesh.positions.buffer,
      mesh.normals.buffer,
      mesh.uvs.buffer,
      mesh.indices.buffer,
    ]);
  } catch (error) {
    const message: TerrainWorkerResponse = {
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    };
    scope.postMessage(message);
  }
};
