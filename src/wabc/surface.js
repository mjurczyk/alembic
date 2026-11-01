import { WabcCodec } from 'alembic';

const { cornerOffsets, getCellCase, getLocalEdge } = WabcCodec;

// NOTE Meshes extracted from a regular grid (FORMAT.md 6.5). Each vertex is on a grid edge whose 2 nodes have
// different signs (inside, outside). The loader rebuilds the vertices and triangles from the signs.

// NOTE A coordinate is on a grid plane if it is closer than this part of the spacing
const planeTolerance = 1e-3;
const otherAxes = [
  [1, 2],
  [0, 2],
  [0, 1],
];

const isOnPlane = (value, { spacing, origin }) => {
  const g = (value - origin) / spacing;

  return Math.abs(g - Math.round(g)) < planeTolerance;
};

// NOTE Most common value of "values" in bins of "binSize", and the mean of the values in that bin
const findMode = (values, binSize) => {
  const bins = new Map();

  for (const value of values) {
    const bin = Math.round(value / binSize);
    const entry = bins.get(bin) ?? bins.set(bin, { count: 0, sum: 0 }).get(bin);

    entry.count++;
    entry.sum += value;
  }

  let best = null;

  for (const entry of bins.values()) {
    if (!best || entry.count > best.count) {
      best = entry;
    }
  }

  return best ? best.sum / best.count : null;
};

// NOTE Spacing and origin of one axis (FORMAT.md 6.5). In a mesh made from a grid, two corners of a triangle that are
// on grid planes are 0 or 1 spacing apart, so the spacing is the most common difference that is not 0. The origin is
// the most common position of the values in one spacing. Then a least-squares fit over the values on planes.
const fitAxis = (samples, axis) => {
  let min = Infinity;
  let max = -Infinity;

  for (const { positions } of samples) {
    for (let index = axis; index < positions.length; index += 3) {
      min = Math.min(min, positions[index]);
      max = Math.max(max, positions[index]);
    }
  }

  const extent = max - min;

  if (!(extent > 0)) {
    return null;
  }

  const differences = [];

  for (const { positions, faceIndices } of samples) {
    for (let corner = 0; corner < faceIndices.length; corner += 3) {
      for (let item = 0; item < 3; item++) {
        const a = positions[faceIndices[corner + item] * 3 + axis];
        const b = positions[faceIndices[corner + ((item + 1) % 3)] * 3 + axis];
        const difference = Math.abs(a - b);

        if (difference > extent * 1e-4) {
          differences.push(difference);
        }
      }
    }
  }

  const spacing = findMode(differences, extent * 1e-5);

  if (!spacing) {
    return null;
  }

  const offsets = [];

  for (const { positions } of samples) {
    for (let index = axis; index < positions.length; index += 3) {
      offsets.push(positions[index] - Math.floor(positions[index] / spacing) * spacing);
    }
  }

  let fit = { spacing, origin: findMode(offsets, spacing * 1e-3) };

  // NOTE Least squares of value = origin + k × spacing over the values on planes
  for (let pass = 0; pass < 2; pass++) {
    let count = 0;
    let sumK = 0;
    let sumV = 0;
    let sumKK = 0;
    let sumKV = 0;

    for (const { positions } of samples) {
      for (let index = axis; index < positions.length; index += 3) {
        const value = positions[index];

        if (isOnPlane(value, fit)) {
          const k = Math.round((value - fit.origin) / fit.spacing);

          count++;
          sumK += k;
          sumV += value;
          sumKK += k * k;
          sumKV += k * value;
        }
      }
    }

    const denominator = count * sumKK - sumK * sumK;

    if (count < 2 || denominator === 0) {
      break;
    }

    const slope = (count * sumKV - sumK * sumV) / denominator;

    fit = { spacing: slope, origin: (sumV - slope * sumK) / count };
  }

  return fit;
};

// NOTE Grid of a track from some of its samples ({ positions, faceIndices }). Null if a point of these samples does
// not have 2 coordinates on grid planes.
export const detectGrid = (samples) => {
  const axes = [0, 1, 2].map((axis) => fitAxis(samples, axis));

  if (axes.some((fit) => !fit)) {
    return null;
  }

  for (const { positions } of samples) {
    for (let point = 0; point < positions.length; point += 3) {
      let onPlanes = 0;

      for (let axis = 0; axis < 3; axis++) {
        onPlanes += isOnPlane(positions[point + axis], axes[axis]) ? 1 : 0;
      }

      if (onPlanes < 2) {
        return null;
      }
    }
  }

  return { origin: axes.map(({ origin }) => origin), spacing: axes.map(({ spacing }) => spacing) };
};

// NOTE Grid coordinates of a point: g = (p − origin) / spacing
const toGrid = (positions, point, grid, axis) =>
  (positions[point * 3 + axis] - grid.origin[axis]) / grid.spacing[axis];

// NOTE Smallest and largest node index of the points, on each axis. Null if a point is not on 2 grid planes.
export const getNodeRange = (positions, grid) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let point = 0; point < positions.length / 3; point++) {
    let offPlane = 0;

    for (let axis = 0; axis < 3; axis++) {
      const value = toGrid(positions, point, grid, axis);

      if (Math.abs(value - Math.round(value)) >= planeTolerance) {
        offPlane++;
      }

      min[axis] = Math.min(min[axis], Math.floor(value));
      max[axis] = Math.max(max[axis], Math.ceil(value));
    }

    if (offPlane > 1) {
      return null;
    }
  }

  return { min, max };
};

// NOTE Nodes of the volume: the node range with one node of margin. The margin is outside.
export const createVolume = ({ min, max }) => {
  const first = min.map((value) => value - 1);
  const size = max.map((value, axis) => value + 1 - first[axis] + 1);

  return { first, size, count: size[0] * size[1] * size[2] };
};

const fail = (reason) => ({ error: reason });

// NOTE Work arrays of one volume size, used again for each sample
let workspace = null;

const getWorkspace = (count) => {
  if (workspace?.count !== count) {
    workspace = {
      count,
      edgeFlags: new Uint8Array(count * 3),
      nodeFlags: new Uint8Array(count),
      queue: new Int32Array(count),
      regions: new Int32Array(count),
    };
  }

  return workspace;
};

// NOTE Signs (1: inside), crossing edges in scan order with their t, and the triangles of each cell as local edges.
// "cornerSign": the sign of nodes with a vertex exactly on them. The source treats them as one side.
export const analyseSurface = (sample, grid, volume, cornerSign) => {
  const { positions, faceIndices, faceCounts } = sample;
  const numPoints = positions.length / 3;
  const [nx, ny, nz] = volume.size;
  const steps = [1, nx, nx * ny];

  if (faceCounts.some((count) => count !== 3)) {
    return fail('faces with more than 3 corners');
  }

  // NOTE Edge (node × 3 + axis) and t of each point. Points on a node have the axis −1.
  const pointAxis = new Int8Array(numPoints);
  const pointNode = new Int32Array(numPoints);
  const pointT = new Float64Array(numPoints);

  for (let point = 0; point < numPoints; point++) {
    const local = [0, 0, 0];
    let axis = -1;

    for (let k = 0; k < 3; k++) {
      const value = toGrid(positions, point, grid, k);
      const rounded = Math.round(value);

      if (Math.abs(value - rounded) < planeTolerance) {
        local[k] = rounded - volume.first[k];
      } else if (axis === -1) {
        axis = k;
        local[k] = Math.floor(value) - volume.first[k];
        pointT[point] = value - Math.floor(value);
      } else {
        return fail('a point is not on a grid edge');
      }
    }

    pointAxis[point] = axis;
    pointNode[point] = local[0] + local[1] * nx + local[2] * nx * ny;
  }

  // NOTE Flags: edges with a point, nodes with a point
  const { edgeFlags, nodeFlags, queue, regions } = getWorkspace(volume.count);
  const edgePoints = new Map();
  const nodePoints = new Map();

  edgeFlags.fill(0);
  nodeFlags.fill(0);

  for (let point = 0; point < numPoints; point++) {
    const axis = pointAxis[point];
    const node = pointNode[point];

    if (axis === -1) {
      nodePoints.set(node, point);
      nodeFlags[node] = 1;
      continue;
    }

    const edge = node * 3 + axis;

    if (edgeFlags[edge]) {
      return fail('two points on one grid edge');
    }

    edgeFlags[edge] = 1;
    edgePoints.set(edge, point);
  }

  // NOTE Regions: nodes joined by edges without a point, not through nodes with a point
  const plane = nx * ny;
  let regionCount = 0;

  regions.fill(-1);

  for (let start = 0; start < volume.count; start++) {
    if (regions[start] !== -1) {
      continue;
    }

    let head = 0;
    let tail = 0;
    const region = regionCount++;

    regions[start] = region;
    queue[tail++] = start;

    while (head < tail && !nodeFlags[start]) {
      const node = queue[head++];
      const x = node % nx;
      const y = ((node - x) / nx) % ny;
      const z = (node - x - y * nx) / plane;

      // NOTE Neighbours on −x, +x, −y, +y, −z, +z, with the edge between them
      for (let side = 0; side < 6; side++) {
        const axis = side >> 1;
        const isUp = side & 1;
        const coordinate = axis === 0 ? x : axis === 1 ? y : z;

        if (isUp ? coordinate === volume.size[axis] - 1 : coordinate === 0) {
          continue;
        }

        const other = isUp ? node + steps[axis] : node - steps[axis];
        const edge = (isUp ? node : other) * 3 + axis;

        if (regions[other] === -1 && !edgeFlags[edge] && !nodeFlags[other]) {
          regions[other] = region;
          queue[tail++] = other;
        }
      }
    }
  }

  // NOTE Each edge with a point joins 2 regions with opposite signs. Region 0 has the margin: outside.
  const links = Array.from({ length: regionCount }, () => []);

  for (const edge of edgePoints.keys()) {
    const node = Math.floor(edge / 3);
    const a = regions[node];
    const b = regions[node + steps[edge % 3]];

    if (a === b) {
      return fail('a point is on an edge inside one region');
    }

    links[a].push(b);
    links[b].push(a);
  }

  // NOTE Two colors from region 0 (the margin: outside). Groups of regions not linked to it start with "cornerSign":
  // they are bounded by nodes with a point on them.
  const colors = new Int8Array(regionCount).fill(-1);

  for (let first = 0; first < regionCount; first++) {
    if (colors[first] !== -1) {
      continue;
    }

    const order = [first];

    colors[first] = first === 0 ? 0 : cornerSign;

    for (let item = 0; item < order.length; item++) {
      const region = order[item];

      for (const other of links[region]) {
        if (colors[other] === -1) {
          colors[other] = 1 - colors[region];
          order.push(other);
        } else if (colors[other] === colors[region]) {
          return fail('inside and outside do not agree');
        }
      }
    }
  }

  const signs = new Uint8Array(volume.count);

  for (let z = 0, node = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, node++) {
        signs[node] = colors[regions[node]];

        if (
          (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) &&
          signs[node] !== 0
        ) {
          return fail('the surface touches the margin');
        }
      }
    }
  }

  // NOTE Crossing edges in scan order: node order, then axis. Each one needs a point: on it, or on one of its nodes.
  const edges = [];
  const tValues = [];

  for (let z = 0, node = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, node++) {
        for (let axis = 0; axis < 3; axis++) {
          if ((axis === 0 ? x : axis === 1 ? y : z) === volume.size[axis] - 1) {
            continue;
          }

          const other = node + steps[axis];
          const edge = node * 3 + axis;

          if (signs[node] === signs[other]) {
            if (edgeFlags[edge]) {
              return fail('a point is on an edge without a sign change');
            }

            continue;
          }

          let t;

          if (edgeFlags[edge]) {
            t = pointT[edgePoints.get(edge)];
          } else if (nodeFlags[node]) {
            t = 0;
          } else if (nodeFlags[other]) {
            t = 1;
          } else {
            return fail('a sign change has no point');
          }

          edges.push(edge);
          tValues.push(t);
        }
      }
    }
  }

  // NOTE Triangles of each cell. A point on an edge is in 4 cells, a point on a node in 8.
  const getCells = (point) => {
    const node = pointNode[point];
    const axis = pointAxis[point];
    const cells = [];

    if (axis >= 0) {
      const [a, b] = otherAxes[axis];

      for (const da of [0, 1]) {
        for (const db of [0, 1]) {
          cells.push(node - da * steps[a] - db * steps[b]);
        }
      }
    } else {
      for (const [dx, dy, dz] of cornerOffsets) {
        cells.push(node - dx - dy * nx - dz * nx * ny);
      }
    }

    return cells;
  };

  // NOTE Local edge of a point in a cell, or −1. A point on a node uses the one crossing edge of the cell at that node.
  const getPointEdge = (point, cell) => {
    const node = pointNode[point];
    const axis = pointAxis[point];
    const position = [cell % nx, Math.floor(cell / nx) % ny, Math.floor(cell / (nx * ny))];
    const nodePosition = [node % nx, Math.floor(node / nx) % ny, Math.floor(node / (nx * ny))];
    const offset = nodePosition.map((value, k) => value - position[k]);

    if (offset.some((value) => value < 0 || value > 1)) {
      return -1;
    }

    if (axis >= 0) {
      const [a, b] = otherAxes[axis];

      return offset[axis] === 0 ? getLocalEdge(axis, offset[a], offset[b]) : -1;
    }

    let found = -1;

    for (let k = 0; k < 3; k++) {
      const start = offset[k] === 0 ? node : node - steps[k];

      if (signs[start] !== signs[start + steps[k]]) {
        if (found !== -1) {
          return -2;
        }

        const [a, b] = otherAxes[k];

        found = getLocalEdge(k, offset[a], offset[b]);
      }
    }

    return found;
  };

  const cellTriangles = new Map();
  const unplaced = [];

  // NOTE The source joins the crossing edges at a node with a point on it into one point. The cells around such a node
  // are rebuilt with the table of the other cells, so they do not add to the table.
  const nodeCells = new Set();

  for (const node of nodePoints.keys()) {
    for (const [dx, dy, dz] of cornerOffsets) {
      nodeCells.add(node - dx - dy * nx - dz * nx * ny);
    }
  }

  for (let corner = 0; corner < faceIndices.length; corner += 3) {
    const points = [faceIndices[corner], faceIndices[corner + 1], faceIndices[corner + 2]];
    let placed = false;

    if (points.some((point) => pointAxis[point] === -1)) {
      continue;
    }

    for (const cell of getCells(points[0])) {
      const local = points.map((point) => getPointEdge(point, cell));

      if (local.every((edge) => edge >= 0)) {
        const first = local.indexOf(Math.min(...local));
        const triangle = [local[first], local[(first + 1) % 3], local[(first + 2) % 3]];

        if (!cellTriangles.has(cell)) {
          cellTriangles.set(cell, []);
        }

        cellTriangles.get(cell).push(triangle);
        placed = true;
        break;
      }
    }

    if (!placed) {
      unplaced.push(points.map((point) => (pointAxis[point] === -1 ? 'node' : 'edge')).join('+'));
    }
  }

  if (unplaced.length > 0) {
    const kinds = {};

    unplaced.forEach((kind) => (kinds[kind] = (kinds[kind] ?? 0) + 1));

    return fail(`${unplaced.length} triangles are not in one cell (${JSON.stringify(kinds)})`);
  }

  // NOTE Triangulation of each cell with a sign change, as a text key for the table
  const cases = new Map();
  const neededCases = new Map();

  for (const edge of edges) {
    const node = Math.floor(edge / 3);
    const axis = edge % 3;
    const [a, b] = otherAxes[axis];

    for (const da of [0, 1]) {
      for (const db of [0, 1]) {
        const cell = node - da * steps[a] - db * steps[b];

        if (cases.has(cell) || neededCases.has(cell)) {
          continue;
        }

        if (nodeCells.has(cell)) {
          neededCases.set(cell, getCellCase(signs, volume.size, cell));
          continue;
        }

        const triangles = (cellTriangles.get(cell) ?? [])
          .map((triangle) => triangle.join(','))
          .sort();

        cases.set(cell, [getCellCase(signs, volume.size, cell), triangles.join(' ')]);
      }
    }
  }

  for (const cell of cellTriangles.keys()) {
    if (!cases.has(cell) && !nodeCells.has(cell)) {
      return fail('a cell has triangles and no sign change');
    }
  }

  return {
    signs,
    edges,
    tValues,
    cases: cases.values(),
    neededCases: new Set(neededCases.values()),
    vertexCount: edges.length,
    triangleCount: faceIndices.length / 3,
  };
};

// NOTE Adds the cell cases of a sample to the table. False if a case has an other triangulation.
export const learnCases = (table, cases) => {
  for (const [cellCase, triangles] of cases) {
    if (!table.has(cellCase)) {
      table.set(cellCase, triangles);
    } else if (table.get(cellCase) !== triangles) {
      return false;
    }
  }

  return true;
};
