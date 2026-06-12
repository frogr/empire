// Recursive shadowcasting FOV (8 octants).
// isOpaque must return true for out-of-bounds coordinates.

const OCTANTS: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 0, 0, 1], [0, 1, 1, 0], [0, -1, 1, 0], [-1, 0, 0, 1],
  [-1, 0, 0, -1], [0, -1, -1, 0], [0, 1, -1, 0], [1, 0, 0, -1],
];

export function computeFOV(
  ox: number,
  oy: number,
  radius: number,
  isOpaque: (x: number, y: number) => boolean,
  reveal: (x: number, y: number) => void,
): void {
  reveal(ox, oy);
  const r2 = radius * radius;

  function castLight(
    row: number, start: number, end: number,
    xx: number, xy: number, yx: number, yy: number,
  ): void {
    if (start < end) return;
    let newStart = 0;
    let blocked = false;
    for (let dist = row; dist <= radius && !blocked; dist++) {
      const dy = -dist;
      for (let dx = -dist; dx <= 0; dx++) {
        const curX = ox + dx * xx + dy * xy;
        const curY = oy + dx * yx + dy * yy;
        const lSlope = (dx - 0.5) / (dy + 0.5);
        const rSlope = (dx + 0.5) / (dy - 0.5);
        if (start < rSlope) continue;
        if (end > lSlope) break;
        if (dx * dx + dy * dy <= r2) reveal(curX, curY);
        if (blocked) {
          if (isOpaque(curX, curY)) {
            newStart = rSlope;
          } else {
            blocked = false;
            start = newStart;
          }
        } else if (isOpaque(curX, curY) && dist < radius) {
          blocked = true;
          castLight(dist + 1, start, lSlope, xx, xy, yx, yy);
          newStart = rSlope;
        }
      }
    }
  }

  for (const [xx, xy, yx, yy] of OCTANTS) {
    castLight(1, 1.0, 0.0, xx, xy, yx, yy);
  }
}
