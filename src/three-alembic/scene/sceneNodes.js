import * as Three from 'three';
import { createPointsGeometry } from '../geometry/PointsGeometry.js';
import { createPolyMeshGeometry } from '../geometry/PolyMeshGeometry.js';
import { decomposeExact } from './matrices.js';

const identity = new Three.Matrix4();

// NOTE Position, rotation and scale of the node come from the matrix.
// A matrix with shear has no exact position, rotation and scale, so the node keeps the matrix.
const setNodeMatrix = (node, matrix) => {
  node.matrixAutoUpdate = decomposeExact(matrix, node.position, node.quaternion, node.scale);
  node.matrix.copy(matrix);
};

// NOTE True if a sample of the schema can be different from the first sample
const isAnimated = (schema) => {
  if (!schema) {
    return false;
  }

  const parameters = [schema.normals, schema.uvs, schema.widths].filter(Boolean);

  return !schema.isConstant || parameters.some((parameter) => !parameter.isConstant);
};

// NOTE Tree order: a parent comes before its children. "matrix" is "localMatrix" with the transforms of the parents.
export const collectEntries = (object, parent = null, entries = []) => {
  const entry = {
    object,
    parent,
    node: null,
    matrix: identity,
    localMatrix: null,
    inherits: true,
    animated: isAnimated(object.schema),
  };

  entries.push(entry);
  object.children.forEach((child) => collectEntries(child, entry, entries));

  return entries;
};

// NOTE Time range of all animated schemas. Frames are the samples of the animated schema with the most samples.
export const getTimeline = (entries) =>
  entries
    .filter(({ animated }) => animated)
    .map(({ object }) => object.schema)
    .reduce(
      (timeline, { numSamples, timeSampling }) => {
        const isLongest = numSamples > timeline.numSamples;
        const lastIndex = timeSampling.getLastIndex(numSamples);

        return {
          numSamples: isLongest ? numSamples : timeline.numSamples,
          timeSampling: isLongest ? timeSampling : timeline.timeSampling,
          startTime: Math.min(timeSampling.getSampleTime(0), timeline.startTime),
          endTime: Math.max(timeSampling.getSampleTime(lastIndex), timeline.endTime),
        };
      },
      { numSamples: 1, timeSampling: null, startTime: Infinity, endTime: -Infinity }
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
export const applyMatrices = (entries) => {
  entries.forEach((entry) => {
    const { node, parent, localMatrix, inherits } = entry;
    const parentMatrix = parent ? parent.matrix : identity;

    entry.matrix = parentMatrix;

    if (!localMatrix) {
      return;
    }

    const nodeMatrix = localMatrix.clone();

    // NOTE "inherits" false: the transform ignores the transforms of its parents
    if (inherits) {
      entry.matrix = parentMatrix.clone().multiply(localMatrix);
    } else {
      entry.matrix = localMatrix.clone();

      if (parentMatrix.determinant() !== 0) {
        nodeMatrix.premultiply(parentMatrix.clone().invert());
      }
    }

    setNodeMatrix(node, nodeMatrix);
  });
};

export const disposeUpdates = (updates) => {
  updates.forEach(({ geometry }) => geometry?.dispose());
};

// NOTE Updates for applyUpdates, built in parts (see runProgressive). If cancelled, it disposes its new geometries.
export function* buildUpdates(entries, readSample) {
  const updates = [];
  let isDone = false;

  try {
    for (const entry of entries) {
      const { object } = entry;
      const { schema } = object;
      const type = schema?.type;

      if (!type) {
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

    isDone = true;

    return updates;
  } finally {
    if (!isDone) {
      disposeUpdates(updates);
    }
  }
}

// NOTE Nodes get the new samples, and their old geometries are disposed. Call applyMatrices after Xform updates.
export const applyUpdates = (updates) => {
  updates.forEach(({ entry, sample, geometry }) => {
    const { node } = entry;

    if (!geometry) {
      entry.localMatrix = sample ? new Three.Matrix4().fromArray(sample.matrix) : null;
      entry.inherits = sample ? sample.inherits : true;

      return;
    }

    node.geometry.dispose();
    node.geometry = geometry;

    if (node.isPoints) {
      setPointsSize(node.material, sample);
    }
  });
};

// NOTE Builds and shows the samples of the entries. Nodes change only at the end, all at the same time.
export function* applySamples(entries, readSample) {
  applyUpdates(yield* buildUpdates(entries, readSample));
  applyMatrices(entries);
}
