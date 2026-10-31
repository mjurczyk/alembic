import { AlembicError } from '../core/AlembicError.js';
import { GeomParam } from './GeomParam.js';
import {
  createIndexSelector,
  createTimeSelector,
  getSchemaCompound,
  getSchemaProperty,
  readSampleValues,
} from './utils.js';

const areEqual = (a, b) => {
  if (a === b) {
    return true;
  }

  if (a.length !== b.length) {
    return false;
  }

  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) {
      return false;
    }
  }

  return true;
};

// NOTE /alembic rules: sum(faceCounts) == length(faceIndices), 0 <= index < point count (FORMAT.md 3.2)
const checkTopology = (fullName, numPoints, faceIndices, faceCounts) => {
  let numCorners = 0;

  for (const count of faceCounts) {
    if (count < 0) {
      throw new AlembicError(`Mesh "${fullName}" has a face with ${count} corners.`);
    }

    numCorners += count;
  }

  if (numCorners !== faceIndices.length) {
    throw new AlembicError(
      `Mesh "${fullName}" has ${faceIndices.length} face indices. Its face counts give ${numCorners}.`
    );
  }

  for (const index of faceIndices) {
    if (index < 0 || index >= numPoints) {
      throw new AlembicError(
        `Mesh "${fullName}" has face index ${index}. It has ${numPoints} points.`
      );
    }
  }
};

// NOTE AbcGeom_PolyMesh_v1, compound ".geom" (FORMAT.md 3.2)
export class PolyMesh {
  type = 'PolyMesh';
  object;
  positionsProperty;
  faceIndicesProperty;
  faceCountsProperty;
  velocitiesProperty;
  selfBoundsProperty;
  normals = null;
  uvs = null;

  constructor(object) {
    const compound = getSchemaCompound(object, '.geom');
    const array = { propertyType: 'array' };

    this.object = object;
    this.positionsProperty = getSchemaProperty(compound, 'P', {
      ...array,
      pod: 'float32',
      extent: 3,
      required: true,
    });
    this.faceIndicesProperty = getSchemaProperty(compound, '.faceIndices', {
      ...array,
      pod: 'int32',
      extent: 1,
      required: true,
    });
    this.faceCountsProperty = getSchemaProperty(compound, '.faceCounts', {
      ...array,
      pod: 'int32',
      extent: 1,
      required: true,
    });
    this.velocitiesProperty = getSchemaProperty(compound, '.velocities', {
      ...array,
      pod: 'float32',
      extent: 3,
    });
    this.selfBoundsProperty = getSchemaProperty(compound, '.selfBnds', {
      propertyType: 'scalar',
      pod: 'float64',
      extent: 6,
    });

    const normals = compound.get('N');
    const uvs = compound.get('uv');

    if (normals) {
      this.normals = new GeomParam(normals, { pod: 'float32', extent: 3 });
    }

    if (uvs) {
      this.uvs = new GeomParam(uvs, { pod: 'float32', extent: 2 });
    }
  }

  get numSamples() {
    return this.positionsProperty.numSamples;
  }

  get timeSampling() {
    return this.positionsProperty.timeSampling;
  }

  // NOTE As in the C++ reader. "constant": nothing changes. "homogeneous": only point values change.
  // "heterogeneous": faces can change on each sample.
  get topologyVariance() {
    const { positionsProperty, faceIndicesProperty, faceCountsProperty } = this;

    if (!faceIndicesProperty.isConstant || !faceCountsProperty.isConstant) {
      return 'heterogeneous';
    }

    return positionsProperty.isConstant ? 'constant' : 'homogeneous';
  }

  get isConstant() {
    return this.topologyVariance === 'constant';
  }

  // NOTE Gives null if the mesh has no samples
  getSample(index) {
    return this.readSample(createIndexSelector(index));
  }

  getSampleAtTime(time, mode = 'floor') {
    return this.readSample(createTimeSelector(time, mode));
  }

  // NOTE True if both samples have equal point counts, face counts and face indices.
  // Only then can points be blended.
  hasSameTopology(indexA, indexB) {
    const a = this.getSample(indexA);
    const b = this.getSample(indexB);

    if (!a || !b) {
      return a === b;
    }

    return (
      a.positions.length === b.positions.length &&
      areEqual(a.faceCounts, b.faceCounts) &&
      areEqual(a.faceIndices, b.faceIndices)
    );
  }

  readSample(selectIndex) {
    const positions = readSampleValues(this.positionsProperty, selectIndex);

    if (!positions) {
      return null;
    }

    const faceIndices = readSampleValues(this.faceIndicesProperty, selectIndex) ?? new Int32Array();
    const faceCounts = readSampleValues(this.faceCountsProperty, selectIndex) ?? new Int32Array();

    checkTopology(this.object.fullName, positions.length / 3, faceIndices, faceCounts);

    return {
      positions,
      faceIndices,
      faceCounts,
      velocities: this.velocitiesProperty
        ? readSampleValues(this.velocitiesProperty, selectIndex)
        : null,
      normals: this.normals?.readSample(selectIndex) ?? null,
      uvs: this.uvs?.readSample(selectIndex) ?? null,
      selfBounds: this.selfBoundsProperty
        ? readSampleValues(this.selfBoundsProperty, selectIndex)
        : null,
    };
  }
}
