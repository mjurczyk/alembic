import { BitDecoder, BitEncoder, createModels } from './arithmetic.js';

// NOTE Grid surface samples (src/wabc/FORMAT.md 4.5, 6.5): signs of the volume nodes, coded against the sample before,
// and a code on each crossed edge. The loader makes the vertices and triangles.

export const blockSize = 8;

export const cornerOffsets = [...Array(8).keys()].map((corner) => [
  corner & 1,
  (corner >> 1) & 1,
  (corner >> 2) & 1,
]);

// NOTE Local edge of a cell: x edges 0 to 3, y edges 4 to 7, z edges 8 to 11; the 2 other axes give the number
export const getLocalEdge = (axis, a, b) => axis * 4 + a + 2 * b;

// NOTE Cell case: bit "corner" is the sign of the corner (corner & 1, corner >> 1 & 1, corner >> 2 & 1)
export const getCellCase = (signs, size, cell) => {
  const [nx, ny] = size;
  let value = 0;

  for (let corner = 0; corner < 8; corner++) {
    const [dx, dy, dz] = cornerOffsets[corner];

    if (signs[cell + dx + dy * nx + dz * nx * ny]) {
      value |= 1 << corner;
    }
  }

  return value;
};

// NOTE Context of a node: 3 nodes before it, the node and 3 nodes after it in the sample before (FORMAT.md 4.5)
export const getNodeContext = (signs, previous, node, x, y, z, nx, ny, nz) =>
  (x > 0 ? signs[node - 1] : 0) |
  ((y > 0 ? signs[node - nx] : 0) << 1) |
  ((z > 0 ? signs[node - nx * ny] : 0) << 2) |
  (previous[node] << 3) |
  ((x < nx - 1 ? previous[node + 1] : 0) << 4) |
  ((y < ny - 1 ? previous[node + nx] : 0) << 5) |
  ((z < nz - 1 ? previous[node + nx * ny] : 0) << 6);

export const createSurfaceModels = (tBits) => ({
  blocks: createModels(2),
  nodes: createModels(128),
  t: createModels(1 << (tBits + 1)),
});

// NOTE Sample chunk: block flags and node signs, then the code of each crossed edge (FORMAT.md 4.5).
// "tValues": the position of each crossed edge in scan order, from 0 to 1.
export const encodeSurfaceSample = (signs, previous, size, tValues, tBits) => {
  const [nx, ny, nz] = size;
  const models = createSurfaceModels(tBits);
  const encoder = new BitEncoder();
  const maxCode = (1 << tBits) - 1;
  let lastFlag = 1;

  for (let bz = 0; bz < nz; bz += blockSize) {
    for (let by = 0; by < ny; by += blockSize) {
      for (let bx = 0; bx < nx; bx += blockSize) {
        const ex = Math.min(bx + blockSize, nx);
        const ey = Math.min(by + blockSize, ny);
        const ez = Math.min(bz + blockSize, nz);
        let same = 1;

        for (let z = bz; z < ez && same; z++) {
          for (let y = by; y < ey && same; y++) {
            for (let x = bx, node = x + y * nx + z * nx * ny; x < ex; x++, node++) {
              if (signs[node] !== previous[node]) {
                same = 0;
                break;
              }
            }
          }
        }

        encoder.encode(same, models.blocks, lastFlag);
        lastFlag = same;

        if (same) {
          continue;
        }

        for (let z = bz; z < ez; z++) {
          for (let y = by; y < ey; y++) {
            for (let x = bx, node = x + y * nx + z * nx * ny; x < ex; x++, node++) {
              encoder.encode(
                signs[node],
                models.nodes,
                getNodeContext(signs, previous, node, x, y, z, nx, ny, nz)
              );
            }
          }
        }
      }
    }
  }

  for (const t of tValues) {
    encoder.encodeBits(Math.min(Math.floor(t * (maxCode + 1)), maxCode), tBits, models.t, 0);
  }

  return encoder.finish();
};

// NOTE Signs and edge codes of one sample chunk. "previous": the result of the sample before, or null for sample 0.
// Blocks that are the same as before are copied. Only blocks next to a sign change are searched for crossed edges.
export const decodeSurfaceSample = (bytes, previous, size, tBits) => {
  const [nx, ny, nz] = size;
  const plane = nx * ny;
  const count = nx * ny * nz;
  const blocksX = Math.ceil(nx / blockSize);
  const blocksY = Math.ceil(ny / blockSize);
  const blocksZ = Math.ceil(nz / blockSize);
  const previousSigns = previous?.signs ?? new Uint8Array(count);
  const previousStates = previous?.blockStates ?? new Uint8Array(blocksX * blocksY * blocksZ);
  // NOTE All nodes start as in the sample before. Blocks with flag 0 are decoded over them.
  const signs = previousSigns.slice();
  // NOTE Block state: 0 all outside, 1 all inside, 2 both
  const blockStates = new Uint8Array(blocksX * blocksY * blocksZ);
  const models = createSurfaceModels(tBits);
  const decoder = new BitDecoder(bytes);
  let lastFlag = 1;
  let block = 0;

  for (let bz = 0; bz < nz; bz += blockSize) {
    for (let by = 0; by < ny; by += blockSize) {
      for (let bx = 0; bx < nx; bx += blockSize, block++) {
        const ex = Math.min(bx + blockSize, nx);
        const ey = Math.min(by + blockSize, ny);
        const ez = Math.min(bz + blockSize, nz);
        const same = decoder.decode(models.blocks, lastFlag);

        lastFlag = same;

        if (same) {
          blockStates[block] = previousStates[block];
          continue;
        }

        let inside = 0;

        // NOTE The context of getNodeContext, without a function call for each node
        for (let z = bz; z < ez; z++) {
          for (let y = by; y < ey; y++) {
            for (let x = bx, node = x + y * nx + z * plane; x < ex; x++, node++) {
              const context =
                (x > 0 ? signs[node - 1] : 0) |
                ((y > 0 ? signs[node - nx] : 0) << 1) |
                ((z > 0 ? signs[node - plane] : 0) << 2) |
                (previousSigns[node] << 3) |
                ((x < nx - 1 ? previousSigns[node + 1] : 0) << 4) |
                ((y < ny - 1 ? previousSigns[node + nx] : 0) << 5) |
                ((z < nz - 1 ? previousSigns[node + plane] : 0) << 6);
              const sign = decoder.decode(models.nodes, context);

              signs[node] = sign;
              inside += sign;
            }
          }
        }

        const nodes = (ex - bx) * (ey - by) * (ez - bz);

        blockStates[block] = inside === 0 ? 0 : inside === nodes ? 1 : 2;
      }
    }
  }

  // NOTE A block has crossed edges inside it only if it has both signs, and to the next block only if their states differ
  const found = [];

  block = 0;

  for (let bz = 0; bz < blocksZ; bz++) {
    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++, block++) {
        const state = blockStates[block];
        const differs =
          state === 2 ||
          (bx < blocksX - 1 && blockStates[block + 1] !== state) ||
          (by < blocksY - 1 && blockStates[block + blocksX] !== state) ||
          (bz < blocksZ - 1 && blockStates[block + blocksX * blocksY] !== state);

        if (!differs) {
          continue;
        }

        const ex = Math.min((bx + 1) * blockSize, nx);
        const ey = Math.min((by + 1) * blockSize, ny);
        const ez = Math.min((bz + 1) * blockSize, nz);

        for (let z = bz * blockSize; z < ez; z++) {
          for (let y = by * blockSize; y < ey; y++) {
            for (let x = bx * blockSize, node = x + y * nx + z * plane; x < ex; x++, node++) {
              const sign = signs[node];

              if (x < nx - 1 && sign !== signs[node + 1]) found.push(node * 3);
              if (y < ny - 1 && sign !== signs[node + nx]) found.push(node * 3 + 1);
              if (z < nz - 1 && sign !== signs[node + plane]) found.push(node * 3 + 2);
            }
          }
        }
      }
    }
  }

  // NOTE The codes are in the scan order of the edges (node index, then axis)
  const edges = Int32Array.from(found).sort();
  const tCodes = new Uint8Array(edges.length);

  for (let index = 0; index < edges.length; index++) {
    tCodes[index] = decoder.decodeBits(tBits, models.t, 0);
  }

  return { signs, blockStates, edges, tCodes };
};

// NOTE Table of a track as an array of 256 cases: the local edges of the triangles, or null. Made once for each table.
const tables = new WeakMap();

const getCases = (table) => {
  let cases = tables.get(table);

  if (!cases) {
    cases = new Array(256).fill(null);
    Object.entries(table).forEach(
      ([cellCase, edges]) => (cases[Number(cellCase)] = Int32Array.from(edges))
    );
    tables.set(table, cases);
  }

  return cases;
};

// NOTE Work arrays of buildSurfaceMesh, used again: cell flags of one volume size, the list of used cells, the hash table
const work = {
  visited: new Uint8Array(0),
  used: new Int32Array(0),
  keys: new Int32Array(0),
  values: new Int32Array(0),
};

const grow = (name, length, Type) => {
  if (work[name].length < length) {
    work[name] = new Type(length);
  }

  return work[name];
};

// NOTE Vertices (one for each crossed edge, in scan order) and triangles (from the table of the cell cases). The triangles
// are clockwise when seen from outside, as in the source (FORMAT.md 6.5), or counter-clockwise with "counterClockwise".
// Edge to vertex: a hash table with linear probing and the high bits of a multiplicative hash (the low bits repeat
// for grid edge numbers). No allocation for each vertex or cell.
export const buildSurfaceMesh = (
  { signs, edges, tCodes },
  { grid, volume, tBits, table },
  { counterClockwise = false } = {}
) => {
  const [nx, ny, nz] = volume.size;
  const plane = nx * ny;
  const cases = getCases(table);
  const vertexCount = edges.length;
  const positions = new Float32Array(vertexCount * 3);
  const scale = 1 << tBits;
  const visited =
    work.visited.length === nx * ny * nz
      ? work.visited
      : (work.visited = new Uint8Array(nx * ny * nz));
  // NOTE Steps of the 2 other axes of each axis, and node offsets of the 8 corners of a cell
  const stepA = [nx, 1, 1];
  const stepB = [plane, plane, nx];
  const corners = cornerOffsets.map(([dx, dy, dz]) => dx + dy * nx + dz * plane);
  // NOTE Local edge e: its axis, and the offset of its first node from the cell
  const edgeAxis = new Int32Array(12);
  const edgeOffset = new Int32Array(12);

  for (let localEdge = 0; localEdge < 12; localEdge++) {
    const axis = localEdge >> 2;

    edgeAxis[localEdge] = axis;
    edgeOffset[localEdge] = (localEdge & 1) * stepA[axis] + ((localEdge >> 1) & 1) * stepB[axis];
  }

  let bits = 1;

  while (1 << bits < vertexCount * 2) {
    bits++;
  }

  const mask = (1 << bits) - 1;
  const shift = 32 - bits;
  const keys = grow('keys', 1 << bits, Int32Array);
  const values = grow('values', 1 << bits, Int32Array);

  keys.fill(-1, 0, 1 << bits);

  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const edge = edges[vertex];
    const axis = edge % 3;
    const node = (edge - axis) / 3;
    const x = node % nx;
    const y = ((node - x) / nx) % ny;
    const z = (node - x - y * nx) / plane;
    const offset = (tCodes[vertex] + 0.5) / scale;
    let slot = Math.imul(edge, 0x9e3779b1) >>> shift;

    positions[vertex * 3] =
      grid.origin[0] + (volume.first[0] + x + (axis === 0 ? offset : 0)) * grid.spacing[0];
    positions[vertex * 3 + 1] =
      grid.origin[1] + (volume.first[1] + y + (axis === 1 ? offset : 0)) * grid.spacing[1];
    positions[vertex * 3 + 2] =
      grid.origin[2] + (volume.first[2] + z + (axis === 2 ? offset : 0)) * grid.spacing[2];

    while (keys[slot] !== -1) {
      slot = (slot + 1) & mask;
    }

    keys[slot] = edge;
    values[slot] = vertex;
  }

  const used = grow('used', vertexCount * 4, Int32Array);
  let usedCount = 0;
  let index = new Uint32Array(Math.max(vertexCount * 6, 3));
  let indexLength = 0;
  let missing = -1;

  for (let item = 0; item < vertexCount && missing === -1; item++) {
    const edge = edges[item];
    const axis = edge % 3;
    const node = (edge - axis) / 3;

    for (let corner = 0; corner < 4; corner++) {
      const cell = node - (corner & 1) * stepA[axis] - (corner >> 1) * stepB[axis];

      if (visited[cell]) {
        continue;
      }

      visited[cell] = 1;
      used[usedCount++] = cell;

      let cellCase = 0;

      for (let k = 0; k < 8; k++) {
        cellCase |= signs[cell + corners[k]] << k;
      }

      const triangles = cases[cellCase];

      if (!triangles) {
        missing = cellCase;
        break;
      }

      if (indexLength + triangles.length > index.length) {
        const grown = new Uint32Array(index.length * 2 + triangles.length);

        grown.set(index.subarray(0, indexLength));
        index = grown;
      }

      for (let corner3 = 0; corner3 < triangles.length; corner3 += 3) {
        for (let k = 0; k < 3; k++) {
          // NOTE Counter-clockwise: corners 2 and 3 change places
          const localEdge = triangles[corner3 + (counterClockwise && k > 0 ? 3 - k : k)];
          const target = (cell + edgeOffset[localEdge]) * 3 + edgeAxis[localEdge];
          let slot = Math.imul(target, 0x9e3779b1) >>> shift;

          while (keys[slot] !== target && keys[slot] !== -1) {
            slot = (slot + 1) & mask;
          }

          index[indexLength++] = values[slot];
        }
      }
    }
  }

  for (let item = 0; item < usedCount; item++) {
    visited[used[item]] = 0;
  }

  if (missing !== -1) {
    throw new Error(`The surface has the cell case ${missing}, which is not in its table.`);
  }

  return { positions, index: index.slice(0, indexLength) };
};
