import * as Three from 'three';
import { AlembicError } from 'alembic';
import { triangulateFaces } from './triangulate.js';

// NOTE Items between two yields (see runProgressive)
const partSize = 4096;

// NOTE Scopes with one value for each face corner or face. These split shared points into more vertices.
const splitScopes = ['facevarying', 'uniform'];

// NOTE Index into the parameter values for a face corner, from its corner, face and point (FORMAT.md 3.3)
const createValueIndex = ({ scope, indices }) => {
  const item = {
    constant: () => 0,
    uniform: (corner, face) => face,
    varying: (corner, face, point) => point,
    vertex: (corner, face, point) => point,
    facevarying: (corner) => corner,
  }[scope];

  return indices ? (corner, face, point) => indices[item(corner, face, point)] : item;
};

const getNumItems = (scope, { numPoints, numFaces, numCorners }) =>
  ({
    constant: 1,
    uniform: numFaces,
    varying: numPoints,
    vertex: numPoints,
    facevarying: numCorners,
  }[scope]);

function* createParameter(name, sample, fullName, counts) {
  if (!sample) {
    return null;
  }

  const { scope, extent, values, indices } = sample;
  const numItems = getNumItems(scope, counts);
  const numValues = values.length / extent;
  const actualItems = indices ? indices.length : numValues;

  if (numItems === undefined) {
    throw new AlembicError(`Mesh "${fullName}" has "${name}" values with scope ${scope}.`);
  }

  if (actualItems !== numItems && !(scope === 'constant' && actualItems > 0)) {
    throw new AlembicError(
      `Mesh "${fullName}" has ${actualItems} "${name}" items. Scope ${scope} needs ${numItems}.`
    );
  }

  if (indices) {
    for (let start = 0; start < indices.length; start += partSize) {
      const end = Math.min(start + partSize, indices.length);

      for (let item = start; item < end; item++) {
        if (indices[item] >= numValues) {
          throw new AlembicError(
            `Mesh "${fullName}" has "${name}" index ${indices[item]}. There are ${numValues} values.`
          );
        }
      }

      yield;
    }
  }

  return {
    scope,
    extent,
    indices,
    numValues,
    // NOTE Not-indexed face corner values are different for each corner
    isUnique: scope === 'facevarying' && !indices,
    getValueIndex: createValueIndex(sample),
  };
}

function* getCornerFaces(faceCounts, numCorners) {
  const cornerFaces = new Uint32Array(numCorners);
  let corner = 0;

  for (let face = 0; face < faceCounts.length; face++) {
    cornerFaces.fill(face, corner, corner + faceCounts[face]);
    corner += faceCounts[face];

    if (face % partSize === partSize - 1) {
      yield;
    }
  }

  return cornerFaces;
}

// NOTE Each vertex is one distinct combination of point and split parameter values.
// Gives the vertex of each face corner and the first corner of each vertex.
function* createVertices(faceIndices, cornerFaces, splitParameters, numPoints) {
  const numCorners = faceIndices.length;
  const cornerVertices = new Uint32Array(numCorners);
  const vertexKeys = new Map();
  const vertexCorners = [];
  // NOTE Number keys while all combinations fit in a safe integer
  const range = splitParameters.reduce((total, { numValues }) => total * numValues, numPoints);
  const useNumberKeys = Number.isSafeInteger(range);

  for (let corner = 0; corner < numCorners; corner++) {
    const face = cornerFaces?.[corner];
    const point = faceIndices[corner];
    let key = useNumberKeys ? point : `${point}`;

    for (const { numValues, getValueIndex } of splitParameters) {
      const valueIndex = getValueIndex(corner, face, point);

      key = useNumberKeys ? key * numValues + valueIndex : `${key},${valueIndex}`;
    }

    let vertex = vertexKeys.get(key);

    if (vertex === undefined) {
      vertex = vertexCorners.length;
      vertexKeys.set(key, vertex);
      vertexCorners.push(corner);
    }

    cornerVertices[corner] = vertex;

    if (corner % partSize === partSize - 1) {
      yield;
    }
  }

  return { cornerVertices, vertexCorners: Uint32Array.from(vertexCorners) };
}

function* mapItems(numItems, getItem) {
  const items = new Uint32Array(numItems);

  for (let start = 0; start < numItems; start += partSize) {
    const end = Math.min(start + partSize, numItems);

    for (let item = start; item < end; item++) {
      items[item] = getItem(item);
    }

    yield;
  }

  return items;
}

// NOTE Vertices of a mesh sample, and the face corners of its triangles. Vertex animation uses one layout for all samples.
export function* createPolyMeshLayout(sample, fullName) {
  const { positions, faceIndices, faceCounts } = sample;
  const counts = {
    numPoints: positions.length / 3,
    numFaces: faceCounts.length,
    numCorners: faceIndices.length,
  };
  const parameters = {
    normal: yield* createParameter('N', sample.normals, fullName, counts),
    uv: yield* createParameter('uv', sample.uvs, fullName, counts),
  };
  const splitParameters = Object.values(parameters).filter(
    (parameter) => parameter && splitScopes.includes(parameter.scope)
  );
  const layout = {
    counts,
    faceIndices,
    parameters,
    triangles: yield* triangulateFaces(positions, faceIndices, faceCounts),
    // NOTE 'point', 'corner' (a vertex for each face corner) or 'split'
    vertexType: 'point',
    numVertices: counts.numPoints,
    cornerFaces: null,
    cornerVertices: null,
    vertexCorners: null,
  };

  if (splitParameters.length === 0) {
    return layout;
  }

  // NOTE Only uniform values need the face of a corner
  if (Object.values(parameters).some((parameter) => parameter?.scope === 'uniform')) {
    layout.cornerFaces = yield* getCornerFaces(faceCounts, counts.numCorners);
  }

  if (splitParameters.some(({ isUnique }) => isUnique)) {
    layout.vertexType = 'corner';
    layout.numVertices = counts.numCorners;

    return layout;
  }

  const { cornerVertices, vertexCorners } = yield* createVertices(
    faceIndices,
    layout.cornerFaces,
    splitParameters,
    counts.numPoints
  );

  layout.vertexType = 'split';
  layout.numVertices = vertexCorners.length;
  layout.cornerVertices = cornerVertices;
  layout.vertexCorners = vertexCorners;

  return layout;
}

// NOTE Point of each vertex. Null: the vertex is the point.
export function* getPointSources({ vertexType, faceIndices, vertexCorners, numVertices }) {
  if (vertexType === 'point') {
    return null;
  }

  if (vertexType === 'corner') {
    return faceIndices;
  }

  return yield* mapItems(numVertices, (vertex) => faceIndices[vertexCorners[vertex]]);
}

// NOTE Parameter value of each vertex. Null: the vertex is the value.
export function* getParameterSources(layout, { scope, indices, getValueIndex }) {
  const { vertexType, faceIndices, cornerFaces, vertexCorners, numVertices } = layout;

  if (scope === 'constant') {
    return new Uint32Array(numVertices).fill(indices ? indices[0] : 0);
  }

  // NOTE Vertex and varying scopes: a value for each point
  if (vertexType === 'point') {
    return indices ?? null;
  }

  if (vertexType === 'corner' && scope === 'facevarying') {
    return indices ?? null;
  }

  const getCorner =
    vertexType === 'corner' ? (vertex) => vertex : (vertex) => vertexCorners[vertex];

  return yield* mapItems(numVertices, (vertex) => {
    const corner = getCorner(vertex);

    return getValueIndex(corner, cornerFaces?.[corner], faceIndices[corner]);
  });
}

// NOTE Copies "extent" values for each vertex into "target". "sources" gives the item in "values" (null: same item).
export function* copyVertexValues(target, values, extent, numVertices, sources) {
  if (!sources) {
    target.set(values.subarray(0, numVertices * extent));

    return target;
  }

  for (let start = 0; start < numVertices; start += partSize) {
    const end = Math.min(start + partSize, numVertices);

    for (let vertex = start; vertex < end; vertex++) {
      const source = sources[vertex] * extent;
      const offset = vertex * extent;

      for (let component = 0; component < extent; component++) {
        target[offset + component] = values[source + component];
      }
    }

    yield;
  }

  return target;
}

// NOTE Triangle corners to vertices
function* createIndex({ triangles, vertexType, faceIndices, cornerVertices, numVertices }) {
  const IndexArray = numVertices <= 65536 ? Uint16Array : Uint32Array;
  const cornerVertex = { point: faceIndices, corner: null, split: cornerVertices }[vertexType];

  // NOTE A vertex for each corner: the triangles are the index
  if (!cornerVertex && IndexArray === Uint32Array) {
    return triangles;
  }

  const index = new IndexArray(triangles.length);

  for (let start = 0; start < triangles.length; start += partSize) {
    const end = Math.min(start + partSize, triangles.length);

    if (cornerVertex) {
      for (let item = start; item < end; item++) {
        index[item] = cornerVertex[triangles[item]];
      }
    } else {
      index.set(triangles.subarray(start, end), start);
    }

    yield;
  }

  return index;
}

// NOTE PolyMesh sample to BufferGeometry. Yields after each part of the work (see runProgressive).
// Sample arrays are shared with the reader cache, so all data is copied.
// Without normals in the file, three.js computes vertex normals.
export function* createPolyMeshGeometry(sample, fullName, layout = null) {
  const geometry = new Three.BufferGeometry();

  if (!sample) {
    return geometry;
  }

  // NOTE A layout from createPolyMeshLayout must match the sample
  layout = layout ?? (yield* createPolyMeshLayout(sample, fullName));

  const { numVertices, parameters } = layout;
  const positions = new Float32Array(numVertices * 3);
  const values = { normal: sample.normals?.values, uv: sample.uvs?.values };

  yield* copyVertexValues(
    positions,
    sample.positions,
    3,
    numVertices,
    yield* getPointSources(layout)
  );
  geometry.setAttribute('position', new Three.BufferAttribute(positions, 3));

  for (const [name, parameter] of Object.entries(parameters)) {
    if (!parameter) {
      continue;
    }

    const { extent } = parameter;
    const array = new Float32Array(numVertices * extent);
    const sources = yield* getParameterSources(layout, parameter);

    yield* copyVertexValues(array, values[name], extent, numVertices, sources);
    geometry.setAttribute(name, new Three.BufferAttribute(array, extent));
  }

  geometry.setIndex(new Three.BufferAttribute(yield* createIndex(layout), 1));

  if (!parameters.normal) {
    geometry.computeVertexNormals();
  }

  return geometry;
}
