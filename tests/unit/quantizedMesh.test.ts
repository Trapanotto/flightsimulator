import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WORLD_ORIGIN } from '../../src/geo/constants';
import { terrainTileBounds } from '../../src/geo/tiles';
import { EnuFrame } from '../../src/geo/wgs84';
import { buildTerrainMesh } from '../../src/terrain/buildMesh';
import { decodeQuantizedMesh } from '../../src/terrain/quantizedMesh';

function loadFixture(): ArrayBuffer {
  const file = readFileSync(
    new URL('../fixtures/zurich-z14.terrain', import.meta.url),
  );
  return file.buffer.slice(
    file.byteOffset,
    file.byteOffset + file.byteLength,
  ) as ArrayBuffer;
}

describe('quantized-mesh decoder', () => {
  const buffer = loadFixture();
  const decoded = decodeQuantizedMesh(buffer);
  const bounds = terrainTileBounds(17161, 12503, 14);
  const frame = new EnuFrame(WORLD_ORIGIN);

  it('reads header and vertex counts', () => {
    expect(decoded.vertexCount).toBe(227);
    expect(decoded.triangleCount).toBe(425);
    expect(decoded.indices.length).toBe(1_275);
    expect(decoded.minHeight).toBeCloseTo(401.15, 1);
    expect(decoded.maxHeight).toBeCloseTo(438.99, 1);
  });

  it('decodes all four tile edges', () => {
    expect(decoded.edges.west.length).toBe(4);
    expect(decoded.edges.south.length).toBe(2);
    expect(decoded.edges.east.length).toBe(12);
    expect(decoded.edges.north.length).toBe(13);
  });

  it('extracts normals and metadata extensions', () => {
    expect(decoded.normals).toBeDefined();
    expect(decoded.normals?.length).toBe(227 * 2);
    expect(decoded.metadata).toMatchObject({
      geometricerror: expect.any(Number),
      surfacearea: expect.any(Number),
    });
  });

  it('builds a finite ENU mesh with skirts', () => {
    const mesh = buildTerrainMesh(decoded, bounds, frame);
    const expectedVertices = 227 + 4 + 2 + 12 + 13;
    const expectedSkirtTriangles = (3 + 1 + 11 + 12) * 4;
    const expectedIndices = 1_275 + expectedSkirtTriangles * 3;

    expect(mesh.positions.length).toBe(expectedVertices * 3);
    expect(mesh.uvs.length).toBe(expectedVertices * 2);
    expect(mesh.normals.length).toBe(expectedVertices * 3);
    expect(mesh.indices.length).toBe(expectedIndices);
    expect(mesh.hasNormals).toBe(true);

    for (const value of mesh.positions) expect(Number.isFinite(value)).toBe(true);
    for (const value of mesh.uvs) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }

    for (let i = 0; i < 227; i++) {
      const length = Math.hypot(
        mesh.normals[i * 3],
        mesh.normals[i * 3 + 1],
        mesh.normals[i * 3 + 2],
      );
      expect(length).toBeCloseTo(1, 4);
    }
  });

  it('places the tile near Zurich', () => {
    const mesh = buildTerrainMesh(decoded, bounds, frame);
    const centerX = (bounds.west + bounds.east) / 2;
    const centerLat = (bounds.south + bounds.north) / 2;
    const expected = frame.toEnu(centerX, centerLat, 420);

    const vertexCount = decoded.vertexCount;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < vertexCount; i++) {
      const dx = mesh.positions[i * 3] - expected.e;
      const dz = mesh.positions[i * 3 + 2] - -expected.n;
      best = Math.min(best, Math.hypot(dx, dz));
    }
    expect(best).toBeLessThan(2_500);
  });
});
