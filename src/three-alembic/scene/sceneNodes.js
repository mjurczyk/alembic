import * as Three from 'three';
import { createPointsGeometry } from '../geometry/PointsGeometry.js';
import { createPolyMeshGeometry } from '../geometry/PolyMeshGeometry.js';

const identity = new Three.Matrix4();
const composed = new Three.Matrix4();

// NOTE Position, rotation and scale of the node come from the matrix.
// A matrix with shear has no exact position, rotation and scale, so the node keeps the matrix.
const setNodeMatrix = (node, matrix) => {
  matrix.decompose(node.position, node.quaternion, node.scale);
  composed.compose(node.position, node.quaternion, node.scale);

  const maxElement = Math.max(...matrix.elements.map(Math.abs));
  const isExact = composed.elements.every(
    (element, index) => Math.abs(element - matrix.elements[index]) <= maxElement * 1e-6
  );

  node.matrix.copy(matrix);
  node.matrixAutoUpdate = isExact;
};

// NOTE True if a sample of the schema can be different from the first sample
const isAnimated = (schema) => {
  if (!schema) {
    return false;
  }

  const parameters = [schema.normals, schema.uvs, schema.widths].filter(Boolean);

  return !schema.isConstant || parameters.some((parameter) => !parameter.isConstant);
};

// NOTE Entries are in tree order: a parent comes before its children
export const collectEntries = (object, parent = null, entries = []) => {
  const entry = { object, parent, node: null, matrix: identity, xformSample: null };

  entry.animated = isAnimated(object.schema);
  entries.push(entry);
  object.children.forEach((child) => collectEntries(child, entry, entries));

  return entries;
};

// NOTE The animated schema with the most samples. Its samples are the frames.
export const getTimeline = (entries) =>
  entries
    .filter(({ animated }) => animated)
    .map(({ object }) => object.schema)
    .reduce(
      (longest, { numSamples, timeSampling }) =>
        numSamples > longest.numSamples ? { numSamples, timeSampling } : longest,
      { numSamples: 1, timeSampling: null }
    );

export const setNodeInfo = (node, object) => {
  node.name = object.name;
  node.userData = {
    fullName: object.fullName,
    metadata: { ...object.metadata },
    schema: object.schema?.type ?? null,
  };

  return node;
};

// NOTE Xforms, and objects with other schemas, are a Group. Their children are still read (FORMAT.md section 5).
export const createNode = (object) => {
  const type = object.schema?.type ?? null;
  let node;

  if (type === 'PolyMesh') {
    node = new Three.Mesh(new Three.BufferGeometry(), new Three.MeshStandardMaterial());
  } else if (type === 'Points') {
    node = new Three.Points(new Three.BufferGeometry(), new Three.PointsMaterial());
  } else {
    node = new Three.Group();
  }

  return setNodeInfo(node, object);
};

// NOTE PointsMaterial has one size for all points. It is the first width of the sample, if there is one.
const setPointsSize = (material, sample) => {
  const widths = sample?.widths;
  const width = widths?.values[widths.indices ? widths.indices[0] : 0];
  const sizeAttenuation = width !== undefined;

  if (material.sizeAttenuation !== sizeAttenuation) {
    material.sizeAttenuation = sizeAttenuation;
    material.needsUpdate = true;
  }

  material.size = sizeAttenuation ? width : 1;
};

// NOTE Matrix of each Xform node. A transform with "inherits" false uses the transforms of its parents.
const applyMatrices = (entries) => {
  entries.forEach((entry) => {
    const { node, parent, xformSample } = entry;
    const parentMatrix = parent ? parent.matrix : identity;

    entry.matrix = parentMatrix;

    if (!xformSample) {
      return;
    }

    const localMatrix = new Three.Matrix4().fromArray(xformSample.matrix);

    // NOTE "inherits" false: the transform ignores the transforms of its parents
    if (xformSample.inherits) {
      entry.matrix = parentMatrix.clone().multiply(localMatrix);
    } else {
      entry.matrix = localMatrix.clone();

      if (parentMatrix.determinant() !== 0) {
        localMatrix.premultiply(parentMatrix.clone().invert());
      }
    }

    setNodeMatrix(node, localMatrix);
  });
};

// NOTE readSample( schema ) gives the sample to show. With onlyAnimated, constant objects keep their sample.
// Yields after each part of the work (see runProgressive). Nodes change only at the end, all at the same time.
export function* applySamples(entries, readSample, { onlyAnimated = false } = {}) {
  const updates = [];
  let isApplied = false;

  try {
    for (const entry of entries) {
      const { object, animated } = entry;
      const { schema } = object;
      const type = schema?.type;

      if (!type || (onlyAnimated && !animated)) {
        continue;
      }

      // NOTE A sample read cannot be split. It has a part of its own.
      yield true;

      const sample = readSample(schema);

      yield true;

      if (type === 'Xform') {
        updates.push({ entry, sample });
      } else if (type === 'PolyMesh') {
        updates.push({
          entry,
          sample,
          geometry: yield* createPolyMeshGeometry(sample, object.fullName),
        });
      } else if (type === 'Points') {
        updates.push({ entry, sample, geometry: createPointsGeometry(sample) });
      }
    }

    updates.forEach(({ entry, sample, geometry }) => {
      const { node } = entry;

      if (!geometry) {
        entry.xformSample = sample;

        return;
      }

      node.geometry.dispose();
      node.geometry = geometry;

      if (node.isPoints) {
        setPointsSize(node.material, sample);
      }
    });

    applyMatrices(entries);
    isApplied = true;
  } finally {
    // NOTE Cancelled: the new geometries are not used
    if (!isApplied) {
      updates.forEach(({ geometry }) => geometry?.dispose());
    }
  }
}
