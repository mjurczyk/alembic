import { BitDecoder } from './arithmetic.js';
import {
  blockSize,
  createSurfaceModels,
  getCellCase,
  getLocalEdge,
  getNodeContext,
} from './surface.js';

// NOTE What a loader rebuilds from a .wabc file (FORMAT.md 6.5, 6.6): grid surfaces, delta positions and normals.

const otherAxes = [
  [1, 2],
  [0, 2],
  [0, 1],
];

// NOTE Signs of the volume nodes and the t code of each crossing edge, from one sample chunk and the signs before it
export const decodeSurfaceSample = (bytes, previous, size, tBits) => {
  const [nx, ny, nz] = size;
  const signs = new Uint8Array(nx * ny * nz);
  const models = createSurfaceModels(tBits);
  const decoder = new BitDecoder(bytes);
  let lastFlag = 1;

  for (let bz = 0; bz < nz; bz += blockSize) {
    for (let by = 0; by < ny; by += blockSize) {
      for (let bx = 0; bx < nx; bx += blockSize) {
        const ex = Math.min(bx + blockSize, nx);
        const ey = Math.min(by + blockSize, ny);
        const ez = Math.min(bz + blockSize, nz);
        const same = decoder.decode(models.blocks, lastFlag);

        lastFlag = same;

        for (let z = bz; z < ez; z++) {
          for (let y = by; y < ey; y++) {
            for (let x = bx, node = x + y * nx + z * nx * ny; x < ex; x++, node++) {
              signs[node] = same
                ? previous[node]
                : decoder.decode(
                    models.nodes,
                    getNodeContext(signs, previous, node, x, y, z, nx, ny, nz)
                  );
            }
          }
        }
      }
    }
  }

  const edges = [];

  for (let z = 0, node = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, node++) {
        if (x < nx - 1 && signs[node] !== signs[node + 1]) edges.push(node * 3);
        if (y < ny - 1 && signs[node] !== signs[node + nx]) edges.push(node * 3 + 1);
        if (z < nz - 1 && signs[node] !== signs[node + nx * ny]) edges.push(node * 3 + 2);
      }
    }
  }

  const tCodes = new Uint32Array(edges.length);

  for (let index = 0; index < edges.length; index++) {
    tCodes[index] = decoder.decodeBits(tBits, models.t, 0);
  }

  return { signs, edges, tCodes };
};

// NOTE Vertices (one for each crossing edge, in scan order) and triangles (from the table of the cell cases)
export const buildSurfaceMesh = ({ signs, edges, tCodes }, { grid, volume, tBits, table }) => {
  const [nx, ny] = volume.size;
  const steps = [1, nx, nx * ny];
  const positions = new Float32Array(edges.length * 3);
  const vertexOfEdge = new Map();
  const cases = new Map(Object.entries(table).map(([cellCase, list]) => [Number(cellCase), list]));
  const index = [];
  const visited = new Set();

  edges.forEach((edge, vertex) => {
    const node = Math.floor(edge / 3);
    const axis = edge % 3;
    const local = [node % nx, Math.floor(node / nx) % ny, Math.floor(node / (nx * ny))];

    vertexOfEdge.set(edge, vertex);

    for (let k = 0; k < 3; k++) {
      const offset = k === axis ? (tCodes[vertex] + 0.5) / (1 << tBits) : 0;

      positions[vertex * 3 + k] =
        grid.origin[k] + (volume.first[k] + local[k] + offset) * grid.spacing[k];
    }
  });

  for (const edge of edges) {
    const node = Math.floor(edge / 3);
    const [a, b] = otherAxes[edge % 3];

    for (const da of [0, 1]) {
      for (const db of [0, 1]) {
        const cell = node - da * steps[a] - db * steps[b];

        if (visited.has(cell)) {
          continue;
        }

        visited.add(cell);

        const triangles = cases.get(getCellCase(signs, volume, cell));

        if (!triangles) {
          throw new Error(`Cell case ${getCellCase(signs, volume, cell)} is not in the table.`);
        }

        for (const localEdge of triangles) {
          const axis = Math.floor(localEdge / 4);
          const [p, q] = otherAxes[axis];
          const bits = localEdge % 4;
          const edgeNode = cell + (bits & 1) * steps[p] + (bits >> 1) * steps[q];

          index.push(vertexOfEdge.get(edgeNode * 3 + axis));
        }
      }
    }
  }

  return { positions, index: Uint32Array.from(index) };
};

// NOTE Positions stored as differences from the vertex before (FORMAT.md 6.6): a sum, with 16-bit wrap
export const undoDeltas = (codes, stride, offset, vertexCount) => {
  const out = new Int16Array(vertexCount * 3);
  const sums = [0, 0, 0];

  for (let vertex = 0; vertex < vertexCount; vertex++) {
    for (let k = 0; k < 3; k++) {
      sums[k] = ((sums[k] + codes[vertex * stride + offset + k]) << 16) >> 16;
      out[vertex * 3 + k] = sums[k];
    }
  }

  return out;
};

// NOTE Flat normal of each triangle (a, b, c): normalized (c − a) × (b − a) (FORMAT.md 8.4)
export const getFlatNormals = (positions, index) => {
  const normals = new Float32Array((index.length / 3) * 3);

  for (let triangle = 0; triangle < index.length / 3; triangle++) {
    const [a, b, c] = [index[triangle * 3], index[triangle * 3 + 1], index[triangle * 3 + 2]].map(
      (v) => v * 3
    );
    const u = [0, 1, 2].map((k) => positions[c + k] - positions[a + k]);
    const v = [0, 1, 2].map((k) => positions[b + k] - positions[a + k]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(...n) || 1;

    for (let k = 0; k < 3; k++) {
      normals[triangle * 3 + k] = n[k] / length;
    }
  }

  return normals;
};
