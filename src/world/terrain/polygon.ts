/**
 * Mean width of a polygon (outer rings minus holes): 2 * area / perimeter. A long river of width
 * w and length L gives about (2 w L) / (2 L) = w; a round lake gives its radius. Units of the
 * input. Used to tell wide rivers (drawn as water) from streams and canals (left to the photo).
 */
export function meanWidth(rings: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>): number {
  let area = 0;
  let perimeter = 0;
  for (const ring of rings) {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      a += p.x * q.y - q.x * p.y;
      perimeter += Math.hypot(q.x - p.x, q.y - p.y);
    }
    // Outer rings and holes wind in opposite directions: the signed sum is the net area.
    area += a / 2;
  }
  return perimeter > 0 ? (2 * Math.abs(area)) / perimeter : 0;
}
