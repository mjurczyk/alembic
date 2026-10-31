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
    for (let item = 0; item < indices.length; item++) {
      if (indices[item] >= numValues) {
        throw new AlembicError(
          `Mesh "${fullName}" has "${name}" index ${indices[item]}. There are ${numValues} values.`
        );
      }

      if (item % partSize === partSize - 1) {
        yield;
      }
    }
  }

  return {
    scope,
    extent,
    values,
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

  // NOTE One vertex for each corner
  if (splitParameters.some(({ isUnique }) => isUnique)) {
    for (let corner = 0; corner < numCorners; corner++) {
      cornerVertices[corner] = corner;
    }

    return { cornerVertices, vertexCorners: cornerVertices };
  }

  const vertexKeys = new Map();
  const vertexCorners = [];
  // NOTE Number keys while all combinations fit in a safe integer
  const range = splitParameters.reduce((total, { numValues }) => total * numValues, numPoints);
  const useNumberKeys = Number.isSafeInteger(range);

  for (let corner = 0; corner < numCorners; corner++) {
    const face = cornerFaces[corner];
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

// NOTE Copies "extent" values for each vertex. getSourceIndex( vertex ) gives the item in "values".
function* createAttribute(values, extent, numVertices, getSourceIndex) {
  const array = new Float32Array(numVertices * extent);

  for (let vertex = 0; vertex < numVertices; vertex++) {
    const source = getSourceIndex(vertex) * extent;
    const target = vertex * extent;

    for (let component = 0; component < extent; component++) {
      array[target + component] = values[source + component];
    }

    if (vertex % partSize === partSize - 1) {
      yield;
    }
  }

  return new Three.BufferAttribute(array, extent);
}

// NOTE PolyMesh sample to BufferGeometry. Yields after each part of the work (see runProgressive).
// Sample arrays are shared with the reader cache, so all data is copied.
// Without normals in the file, three.js computes vertex normals.
export function* createPolyMeshGeometry(sample, fullName) {
  const geometry = new Three.BufferGeometry();

  if (!sample) {
    return geometry;
  }

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
  const triangles = yield* triangulateFaces(positions, faceIndices, faceCounts);
  let cornerVertices, vertexCorners, cornerFaces;

  // NOTE No split: one vertex for each point, and the index buffer is a copy of the face indices
  if (splitParameters.length === 0) {
    cornerVertices = faceIndices;
    geometry.setAttribute('position', new Three.BufferAttribute(positions.slice(), 3));
  } else {
    cornerFaces = yield* getCornerFaces(faceCounts, counts.numCorners);
    ({ cornerVertices, vertexCorners } = yield* createVertices(
      faceIndices,
      cornerFaces,
      splitParameters,
      counts.numPoints
    ));

    geometry.setAttribute(
      'position',
      yield* createAttribute(
        positions,
        3,
        vertexCorners.length,
        (vertex) => faceIndices[vertexCorners[vertex]]
      )
    );
  }

  const numVertices = geometry.getAttribute('position').count;

  for (const [name, parameter] of Object.entries(parameters)) {
    if (!parameter) {
      continue;
    }

    const { values, extent, getValueIndex } = parameter;

    // NOTE Without split, vertex is point. Constant, varying and vertex scopes do not use corner and face.
    const getSourceIndex = vertexCorners
      ? (vertex) => {
          const corner = vertexCorners[vertex];

          return getValueIndex(corner, cornerFaces[corner], faceIndices[corner]);
        }
      : (vertex) => getValueIndex(-1, -1, vertex);

    geometry.setAttribute(
      name,
      yield* createAttribute(values, extent, numVertices, getSourceIndex)
    );
  }

  const IndexArray = numVertices <= 65536 ? Uint16Array : Uint32Array;
  const index = new IndexArray(triangles.length);

  for (let item = 0; item < triangles.length; item++) {
    index[item] = cornerVertices[triangles[item]];

    if (item % partSize === partSize - 1) {
      yield;
    }
  }

  geometry.setIndex(new Three.BufferAttribute(index, 1));

  if (!parameters.normal) {
    geometry.computeVertexNormals();
  }

  return geometry;
}
