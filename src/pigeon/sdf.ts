export type Field = (x: number, y: number, z: number) => number;

export function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Ellipsoid, optionally pitched so its local +Z tilts toward +Y by `a` radians. */
export function ell(
  x: number, y: number, z: number,
  cx: number, cy: number, cz: number,
  rx: number, ry: number, rz: number,
  a = 0,
): number {
  const dx = x - cx;
  let dy = y - cy;
  let dz = z - cz;
  if (a !== 0) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const ly = dy * c - dz * s;
    const lz = dz * c + dy * s;
    dy = ly;
    dz = lz;
  }
  const qx = dx / rx, qy = dy / ry, qz = dz / rz;
  const k0 = Math.sqrt(qx * qx + qy * qy + qz * qz);
  const px = dx / (rx * rx), py = dy / (ry * ry), pz = dz / (rz * rz);
  const k1 = Math.sqrt(px * px + py * py + pz * pz);
  if (k1 < 1e-9) return -Math.min(rx, ry, rz);
  return (k0 * (k0 - 1)) / k1;
}

/** Capsule whose radius tapers linearly from a to b. */
export function cone(
  x: number, y: number, z: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  ra: number, rb: number,
): number {
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const pax = x - ax, pay = y - ay, paz = z - az;
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz)));
  const qx = pax - bax * h, qy = pay - bay * h, qz = paz - baz * h;
  return Math.sqrt(qx * qx + qy * qy + qz * qz) - (ra + (rb - ra) * h);
}

const CORNERS = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
] as const;
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
] as const;

/**
 * Naive surface nets. Chosen over marching cubes because it gives one well-shaped vertex per cell,
 * which projects cleanly onto the surface and skins smoothly.
 */
export function surfaceNets(
  f: Field,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  h: number,
): { positions: number[]; indices: number[] } {
  const nx = Math.ceil((max[0] - min[0]) / h) + 1;
  const ny = Math.ceil((max[1] - min[1]) / h) + 1;
  const nz = Math.ceil((max[2] - min[2]) / h) + 1;
  const vals = new Float32Array(nx * ny * nz);
  const id = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) vals[id(i, j, k)] = f(min[0] + i * h, min[1] + j * h, min[2] + k * h);

  const cx = nx - 1, cy = ny - 1, cz = nz - 1;
  const cell = new Int32Array(cx * cy * cz).fill(-1);
  const cid = (i: number, j: number, k: number) => i + cx * (j + cy * k);
  const positions: number[] = [];
  const cv = new Float32Array(8);

  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const o = CORNERS[c];
          cv[c] = vals[id(i + o[0], j + o[1], k + o[2])];
          if (cv[c] < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of EDGES) {
          const va = cv[a], vb = cv[b];
          if (va < 0 === vb < 0) continue;
          const t = va / (va - vb);
          const A = CORNERS[a], B = CORNERS[b];
          sx += A[0] + (B[0] - A[0]) * t;
          sy += A[1] + (B[1] - A[1]) * t;
          sz += A[2] + (B[2] - A[2]) * t;
          n++;
        }
        cell[cid(i, j, k)] = positions.length / 3;
        positions.push(min[0] + (i + sx / n) * h, min[1] + (j + sy / n) * h, min[2] + (k + sz / n) * h);
      }

  const indices: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, d, c, a, c, b);
    else indices.push(a, b, c, a, c, d);
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const v0 = vals[id(i, j, k)];
        if (i < nx - 1 && j >= 1 && k >= 1 && j <= ny - 2 && k <= nz - 2) {
          const v1 = vals[id(i + 1, j, k)];
          if (v0 < 0 !== v1 < 0)
            quad(cell[cid(i, j - 1, k - 1)], cell[cid(i, j, k - 1)], cell[cid(i, j, k)], cell[cid(i, j - 1, k)], !(v0 < 0));
        }
        if (j < ny - 1 && i >= 1 && k >= 1 && i <= nx - 2 && k <= nz - 2) {
          const v1 = vals[id(i, j + 1, k)];
          if (v0 < 0 !== v1 < 0)
            quad(cell[cid(i - 1, j, k - 1)], cell[cid(i - 1, j, k)], cell[cid(i, j, k)], cell[cid(i, j, k - 1)], !(v0 < 0));
        }
        if (k < nz - 1 && i >= 1 && j >= 1 && i <= nx - 2 && j <= ny - 2) {
          const v1 = vals[id(i, j, k + 1)];
          if (v0 < 0 !== v1 < 0)
            quad(cell[cid(i - 1, j - 1, k)], cell[cid(i, j - 1, k)], cell[cid(i, j, k)], cell[cid(i - 1, j, k)], !(v0 < 0));
        }
      }
  return { positions, indices };
}
