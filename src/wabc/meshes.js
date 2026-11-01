import { triangulateFaces } from './triangulate.js';

// NOTE Scopes that give each face corner its own value: these split points into more vertices (FORMAT.md 8.4)
const splitScopes = ['facevarying', 'uniform'];

// NOTE Item of the scope for a face corner, from its corner, face and point (alembic FORMAT.md 3.3)
const scopeItems = {
  constant: () => 0,
  uniform: (corner, face) => face,
  varying: (corner, face, point) => point,
  vertex: (corner, face, point) => point,
  facevarying: (corner) => corner,
};

const getNumItems = (scope, { numPoints, numFaces, numCorners }) =>
  ({
    constant: 1,
    uniform: numFaces,
    varying: numPoints,
    vertex: numPoints,
    facevarying: numCorners,
  }[scope]);

const createParameter = (name, sample, path, counts) => {
  if (!sample) {
    return null;
  }

  const { scope, extent, values, indices } = sample;
  const getItem = scopeItems[scope];
  const numValues = values.length / extent;
  const numItems = getNumItems(scope, counts);
  const actualItems = indices ? indices.length : numValues;

  if (!getItem) {
    throw new Error(`Mesh "${path}" has "${name}" values with the scope ${scope}.`);
  }

  if (actualItems !== numItems && !(scope === 'constant' && actualItems > 0)) {
    throw new Error(
      `Mesh "${path}" has ${actualItems} "${name}" items. Scope ${scope} needs ${numItems}.`
    );
  }

  if (indices) {
    for (const index of indices) {
      if (index >= numValues) {
        throw new Error(
          `Mesh "${path}" has "${name}" index ${index}. There are ${numValues} values.`
        );
      }
    }
  }

  return {
    scope,
    extent,
    numValues,
    // NOTE Not indexed face corner values: each face corner has its own value
    isUnique: scope === 'facevarying' && !indices,
    getValueIndex: indices
      ? (corner, face, point) => indices[getItem(corner, face, point)]
      : getItem,
  };
};

const getCornerFaces = (faceCounts, numCorners) => {
  const cornerFaces = new Uint32Array(numCorners);
  let corner = 0;

  faceCounts.forEach((count, face) => {
    cornerFaces.fill(face, corner, corner + count);
    corner += count;
  });

  return cornerFaces;
};

// NOTE Each vertex is one distinct combination of a point and the split parameter values
const splitVertices = (faceIndices, cornerFaces, splitParameters, numPoints) => {
  const numCorners = faceIndices.length;
  const cornerVertices = new Uint32Array(numCorners);
  const vertexCorners = [];
  const keys = new Map();
  // NOTE Number keys while all combinations fit in a safe integer
  const range = splitParameters.reduce((total, { numValues }) => total * numValues, numPoints);
  const useNumberKeys = Number.isSafeInteger(range);

  for (let corner = 0; corner < numCorners; corner++) {
    const face = cornerFaces?.[corner];
    const point = faceIndices[corner];
    let key = useNumberKeys ? point : `${point}`;

    for (const { numValues, getValueIndex } of splitParameters) {
      const value = getValueIndex(corner, face, point);

      key = useNumberKeys ? key * numValues + value : `${key},${value}`;
    }

    let vertex = keys.get(key);

    if (vertex === undefined) {
      vertex = vertexCorners.length;
      keys.set(key, vertex);
      vertexCorners.push(corner);
    }

    cornerVertices[corner] = vertex;
  }

  return { cornerVertices, vertexCorners: Uint32Array.from(vertexCorners) };
};

// NOTE True if each vertex is in exactly one triangle corner. Then the mesh needs no index buffer (FORMAT.md 8.4).
const isUsedOnce = (index, vertexCount) => {
  if (index.length !== vertexCount) {
    return false;
  }

  const used = new Uint8Array(vertexCount);

  for (const vertex of index) {
    if (used[vertex]) {
      return false;
    }

    used[vertex] = 1;
  }

  return true;
};

// NOTE Vertices and triangles of a PolyMesh sample. A "vertex" track uses the layout of its first sample for all samples.
// "vertexPoints": point of each vertex. "vertexValues": N or uv value of each vertex. "index": null if not indexed.
export const createMeshLayout = (sample, path) => {
  const { positions, faceIndices, faceCounts } = sample;
  const counts = {
    numPoints: positions.length / 3,
    numFaces: faceCounts.length,
    numCorners: faceIndices.length,
  };
  const parameters = {
    normal: createParameter('N', sample.normals, path, counts),
    uv: createParameter('uv', sample.uvs, path, counts),
  };
  const usedParameters = Object.entries(parameters).filter(([, parameter]) => parameter);
  const splitParameters = usedParameters
    .map(([, parameter]) => parameter)
    .filter(({ scope }) => splitScopes.includes(scope));
  const needsFaces = usedParameters.some(([, { scope }]) => scope === 'uniform');
  const cornerFaces = needsFaces ? getCornerFaces(faceCounts, counts.numCorners) : null;
  const triangles = triangulateFaces(positions, faceIndices, faceCounts);
  // NOTE "point": a vertex for each point. "corner": a vertex for each face corner. "split": a vertex for each combination.
  let type = 'point';
  let cornerVertices = faceIndices;
  let vertexCorners = null;

  if (splitParameters.some(({ isUnique }) => isUnique)) {
    type = 'corner';
    cornerVertices = null;
  } else if (splitParameters.length > 0) {
    type = 'split';
    ({ cornerVertices, vertexCorners } = splitVertices(
      faceIndices,
      cornerFaces,
      splitParameters,
      counts.numPoints
    ));
  }

  const vertexCount = {
    point: counts.numPoints,
    corner: counts.numCorners,
    split: vertexCorners?.length,
  }[type];
  const getCorner = type === 'corner' ? (vertex) => vertex : (vertex) => vertexCorners[vertex];
  let vertexPoints = new Uint32Array(vertexCount);
  const vertexValues = {};

  for (let vertex = 0; vertex < vertexCount; vertex++) {
    vertexPoints[vertex] = type === 'point' ? vertex : faceIndices[getCorner(vertex)];
  }

  for (const [name, parameter] of usedParameters) {
    const values = new Uint32Array(vertexCount);

    for (let vertex = 0; vertex < vertexCount; vertex++) {
      if (type === 'point') {
        // NOTE Without split parameters, all scopes give the value from the point
        values[vertex] = parameter.getValueIndex(0, 0, vertex);
      } else {
        const corner = getCorner(vertex);

        values[vertex] = parameter.getValueIndex(
          corner,
          cornerFaces?.[corner],
          faceIndices[corner]
        );
      }
    }

    vertexValues[name] = values;
  }

  let index = cornerVertices ? triangles.map((corner) => cornerVertices[corner]) : triangles;

  // NOTE Each vertex in one triangle corner: vertices in triangle order, no index buffer (FORMAT.md 8.4)
  if (isUsedOnce(index, vertexCount)) {
    const order = index;

    vertexPoints = order.map((vertex) => vertexPoints[vertex]);

    for (const name of Object.keys(vertexValues)) {
      vertexValues[name] = order.map((vertex) => vertexValues[name][vertex]);
    }

    index = null;
  }

  return {
    counts,
    numNormalValues: parameters.normal?.numValues ?? 0,
    hasNormals: !!parameters.normal,
    hasUvs: !!parameters.uv,
    vertexCount,
    index,
    vertexPoints,
    vertexValues,
  };
};

const gather = (values, sources, extent) => {
  const out = new Float32Array(sources.length * extent);

  for (let vertex = 0; vertex < sources.length; vertex++) {
    const source = sources[vertex] * extent;

    for (let component = 0; component < extent; component++) {
      out[vertex * extent + component] = values[source + component];
    }
  }

  return out;
};

// NOTE Normalized sum of (c − a) × (b − a) of the triangles (a, b, c) of each vertex (FORMAT.md 8.4)
export const computeNormals = (positions, index, vertexCount) => {
  const normals = new Float32Array(vertexCount * 3);
  const sums = new Float64Array(vertexCount * 3);
  const numCorners = index ? index.length : vertexCount;

  for (let corner = 0; corner < numCorners; corner += 3) {
    const a = index ? index[corner] : corner;
    const b = index ? index[corner + 1] : corner + 1;
    const c = index ? index[corner + 2] : corner + 2;
    const acX = positions[c * 3] - positions[a * 3];
    const acY = positions[c * 3 + 1] - positions[a * 3 + 1];
    const acZ = positions[c * 3 + 2] - positions[a * 3 + 2];
    const abX = positions[b * 3] - positions[a * 3];
    const abY = positions[b * 3 + 1] - positions[a * 3 + 1];
    const abZ = positions[b * 3 + 2] - positions[a * 3 + 2];
    const x = acY * abZ - acZ * abY;
    const y = acZ * abX - acX * abZ;
    const z = acX * abY - acY * abX;

    for (const vertex of [a, b, c]) {
      sums[vertex * 3] += x;
      sums[vertex * 3 + 1] += y;
      sums[vertex * 3 + 2] += z;
    }
  }

  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const x = sums[vertex * 3];
    const y = sums[vertex * 3 + 1];
    const z = sums[vertex * 3 + 2];
    const length = Math.hypot(x, y, z);

    // NOTE A vertex without triangle area keeps the normal (0, 0, 0)
    if (length > 0) {
      normals[vertex * 3] = x / length;
      normals[vertex * 3 + 1] = y / length;
      normals[vertex * 3 + 2] = z / length;
    }
  }

  return normals;
};

// NOTE Attribute values of each vertex of a sample, with the layout of createMeshLayout
// "withNormals" false: the loader calculates the normals, so they are not made.
export const getMeshValues = (layout, sample, withNormals = true) => {
  const position = gather(sample.positions, layout.vertexPoints, 3);
  const values = { position };

  if (withNormals) {
    values.normal = layout.hasNormals
      ? gather(sample.normals.values, layout.vertexValues.normal, 3)
      : computeNormals(position, layout.index, layout.vertexCount);
  }

  if (layout.hasUvs) {
    values.uv = gather(sample.uvs.values, layout.vertexValues.uv, 2);
  }

  return values;
};

// NOTE True if the sample fits the layout of the first sample of a "vertex" track
export const fitsLayout = (layout, sample) =>
  sample.positions.length === layout.counts.numPoints * 3 &&
  (!layout.hasNormals || sample.normals?.values.length === layout.numNormalValues * 3);

// NOTE Points: vertex v is point v. "width" has one value for each point (FORMAT.md 8.5).
export const getPointsValues = (sample, path) => {
  const position = Float32Array.from(sample.positions);
  const values = { position };
  const count = position.length / 3;

  if (sample.widths) {
    const widths = sample.widths.getExpandedValues();

    if (widths.length === count) {
      values.width = Float32Array.from(widths);
    } else if (widths.length === 1 || sample.widths.scope === 'constant') {
      values.width = new Float32Array(count).fill(widths[0] ?? 0);
    } else {
      throw new Error(`Points "${path}" have ${widths.length} widths for ${count} points.`);
    }
  }

  return { values, vertexCount: count };
};

// NOTE Normals that the loader can calculate (FORMAT.md 8.4). "flat": N of each face is the normal of the face.
// "smooth": N of each corner is the normalized sum of the normals of the faces at its point, or the mesh has no N.
// "stored": other N. A face normal is (c − a) × (b − a) of its clockwise corners (Newell sum for more corners).
// Gives the faces and corners that are more than 1° off; the track adds them up (decideNormals).
const maxAngleCosine = Math.cos((1 * Math.PI) / 180);
// NOTE Up to 0.1 % of the faces or corners of a track can be off: very small faces have no exact normal
const maxOffShare = 0.001;

export const countNormalErrors = (sample, path) => {
  const { positions, faceIndices, faceCounts } = sample;

  if (!sample.normals) {
    return {
      hasNormals: false,
      faces: faceCounts.length,
      corners: faceIndices.length,
      flatOff: 0,
      smoothOff: 0,
    };
  }

  const counts = {
    numPoints: positions.length / 3,
    numFaces: faceCounts.length,
    numCorners: faceIndices.length,
  };
  const normal = createParameter('N', sample.normals, path, counts);
  const values = sample.normals.values;
  const faceNormals = new Float64Array(counts.numFaces * 3);
  const pointNormals = new Float64Array(counts.numPoints * 3);
  let corner = 0;

  faceCounts.forEach((count, face) => {
    let x = 0;
    let y = 0;
    let z = 0;

    // NOTE Newell normal: it points to the side from which the corners turn counter-clockwise, so it is negated
    for (let item = 0; item < count; item++) {
      const a = faceIndices[corner + item] * 3;
      const b = faceIndices[corner + ((item + 1) % count)] * 3;

      x -= (positions[a + 1] - positions[b + 1]) * (positions[a + 2] + positions[b + 2]);
      y -= (positions[a + 2] - positions[b + 2]) * (positions[a] + positions[b]);
      z -= (positions[a] - positions[b]) * (positions[a + 1] + positions[b + 1]);
    }

    faceNormals.set([x, y, z], face * 3);

    for (let item = 0; item < count; item++) {
      const point = faceIndices[corner + item] * 3;

      pointNormals[point] += x;
      pointNormals[point + 1] += y;
      pointNormals[point + 2] += z;
    }

    corner += count;
  });

  const isClose = (n, source) => {
    const length =
      Math.hypot(n[0], n[1], n[2]) *
      Math.hypot(values[source], values[source + 1], values[source + 2]);

    return (
      length > 0 &&
      (n[0] * values[source] + n[1] * values[source + 1] + n[2] * values[source + 2]) / length >=
        maxAngleCosine
    );
  };
  let flatOff = 0;
  let smoothOff = 0;

  corner = 0;
  faceCounts.forEach((count, face) => {
    const first = normal.getValueIndex(corner, face, faceIndices[corner]) * 3;
    let isFlat = isClose(faceNormals.subarray(face * 3, face * 3 + 3), first);

    for (let item = 0; item < count; item++) {
      const point = faceIndices[corner + item];
      const source = normal.getValueIndex(corner + item, face, point) * 3;

      isFlat =
        isFlat &&
        values[source] === values[first] &&
        values[source + 1] === values[first + 1] &&
        values[source + 2] === values[first + 2];
      smoothOff += isClose(pointNormals.subarray(point * 3, point * 3 + 3), source) ? 0 : 1;
    }

    flatOff += isFlat ? 0 : 1;
    corner += count;
  });

  return {
    hasNormals: true,
    faces: counts.numFaces,
    corners: counts.numCorners,
    flatOff,
    smoothOff,
  };
};

// NOTE "flat", "smooth" or "stored" for a track, from the sums of countNormalErrors of its samples
export const decideNormals = (errors) => {
  const sum = (key) => errors.reduce((total, item) => total + item[key], 0);

  if (errors.every(({ hasNormals }) => !hasNormals)) {
    return 'smooth';
  }

  if (errors.some(({ hasNormals }) => !hasNormals)) {
    return 'stored';
  }

  if (sum('flatOff') <= sum('faces') * maxOffShare) {
    return 'flat';
  }

  return sum('smoothOff') <= sum('corners') * maxOffShare ? 'smooth' : 'stored';
};

// NOTE Spreads the 10 bits of a value: bit i goes to bit 3i
const spreadBits = (value) => {
  let result = 0;

  for (let bit = 0; bit < 10; bit++) {
    result += ((value >> bit) & 1) * 2 ** (3 * bit);
  }

  return result;
};

// NOTE Points in the order of a Morton curve over their box (FORMAT.md 8.5). Close points are next to each other,
// so position deltas are small. The ids are not stored, so the order is free.
export const sortPoints = (values, vertexCount) => {
  const { position } = values;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let index = 0; index < position.length; index++) {
    min[index % 3] = Math.min(min[index % 3], position[index]);
    max[index % 3] = Math.max(max[index % 3], position[index]);
  }

  const keys = new Float64Array(vertexCount);

  for (let vertex = 0; vertex < vertexCount; vertex++) {
    let key = 0;

    for (let axis = 0; axis < 3; axis++) {
      const size = max[axis] - min[axis];
      const cell =
        size > 0
          ? Math.min(1023, Math.floor(((position[vertex * 3 + axis] - min[axis]) / size) * 1024))
          : 0;

      key += spreadBits(cell) * 2 ** axis;
    }

    keys[vertex] = key;
  }

  const order = Uint32Array.from({ length: vertexCount }, (_, vertex) => vertex).sort(
    (a, b) => keys[a] - keys[b]
  );
  const sorted = {};

  for (const [name, array] of Object.entries(values)) {
    const extent = vertexCount > 0 ? array.length / vertexCount : 0;
    const out = new Float32Array(array.length);

    order.forEach((source, vertex) => {
      for (let component = 0; component < extent; component++) {
        out[vertex * extent + component] = array[source * extent + component];
      }
    });

    sorted[name] = out;
  }

  return sorted;
};
