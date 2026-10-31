import { AlembicError } from '../core/AlembicError.js';
import {
  createIndexSelector,
  createTimeSelector,
  getSchemaCompound,
  getSchemaProperty,
  readSampleValues,
} from './utils.js';

// NOTE Op byte: type << 4 | hint. Index is the type (FORMAT.md 3.4).
const opTypes = [
  { name: 'scale', numChannels: 3 },
  { name: 'translate', numChannels: 3 },
  { name: 'rotate', numChannels: 4 },
  { name: 'matrix', numChannels: 16 },
  { name: 'rotateX', numChannels: 1 },
  { name: 'rotateY', numChannels: 1 },
  { name: 'rotateZ', numChannels: 1 },
];

const singleAxes = { rotateX: [1, 0, 0], rotateY: [0, 1, 0], rotateZ: [0, 0, 1] };

const identity = () => Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

// NOTE Column-major 4x4 matrices: target = a × b
const multiply = (a, b) => {
  const target = new Float64Array(16);

  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;

      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + row] * b[column * 4 + k];
      }

      target[column * 4 + row] = sum;
    }
  }

  return target;
};

// NOTE Rotation by "degrees" about the axis, as Imath setAxisAngle. A zero axis stays zero, as in Imath.
const axisAngle = (x, y, z, degrees) => {
  const length = Math.hypot(x, y, z);
  const [ux, uy, uz] = length > 0 ? [x / length, y / length, z / length] : [0, 0, 0];
  const angle = (degrees * Math.PI) / 180;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const t = 1 - cos;

  return Float64Array.of(
    ux * ux * t + cos,
    ux * uy * t + uz * sin,
    ux * uz * t - uy * sin,
    0,
    ux * uy * t - uz * sin,
    uy * uy * t + cos,
    uy * uz * t + ux * sin,
    0,
    ux * uz * t + uy * sin,
    uy * uz * t - ux * sin,
    uz * uz * t + cos,
    0,
    0,
    0,
    0,
    1
  );
};

const getOpMatrix = (name, values, offset) => {
  const matrix = identity();

  if (name === 'matrix') {
    // NOTE Channel 4j + k is Imath m[j][k]. This is the column-major order of three.js (FORMAT.md 3.4).
    matrix.set(values.subarray(offset, offset + 16));

    return matrix;
  }

  if (name in singleAxes) {
    return axisAngle(...singleAxes[name], values[offset]);
  }

  const x = values[offset];
  const y = values[offset + 1];
  const z = values[offset + 2];

  if (name === 'rotate') {
    return axisAngle(x, y, z, values[offset + 3]);
  }

  if (name === 'scale') {
    matrix[0] = x;
    matrix[5] = y;
    matrix[10] = z;
  } else {
    matrix[12] = x;
    matrix[13] = y;
    matrix[14] = z;
  }

  return matrix;
};

// NOTE AbcGeom_Xform_v3, compound ".xform" (FORMAT.md 3.4)
export class Xform {
  type = 'Xform';
  object;
  ops = [];
  numChannels = 0;
  valuesProperty;
  inheritsProperty;
  isConstantIdentity;

  constructor(object) {
    const compound = getSchemaCompound(object, '.xform');
    const isArray = compound.get('.vals')?.propertyType === 'array';

    this.object = object;
    this.inheritsProperty = getSchemaProperty(compound, '.inherits', {
      propertyType: 'scalar',
      pod: 'bool',
      extent: 1,
    });

    // NOTE The writer uses an array property if there are more than 256 channels
    this.valuesProperty = getSchemaProperty(compound, '.vals', {
      propertyType: isArray ? 'array' : 'scalar',
      pod: 'float64',
      extent: isArray ? 1 : undefined,
    });
    this.isConstantIdentity = !compound.get('isNotConstantIdentity');

    const opsProperty = getSchemaProperty(compound, '.ops', {
      propertyType: 'scalar',
      pod: 'uint8',
    });

    // NOTE The C++ reader reads only sample 0 of ".ops"
    if (opsProperty && opsProperty.numSamples > 0) {
      for (const code of opsProperty.getSample(0)) {
        const opType = opTypes[code >> 4];

        if (!opType) {
          throw new AlembicError(
            `Transform "${object.fullName}" has op type ${code >> 4}. Valid op types are 0-6.`
          );
        }

        this.ops.push({ type: opType.name, hint: code & 0xf, numChannels: opType.numChannels });
        this.numChannels += opType.numChannels;
      }
    }
  }

  get numSamples() {
    return Math.max(this.valuesProperty?.numSamples ?? 0, this.inheritsProperty?.numSamples ?? 0);
  }

  get timeSampling() {
    const property = this.inheritsProperty ?? this.valuesProperty;

    return property ? property.timeSampling : this.object.archive.timeSamplings[0];
  }

  // NOTE As in the C++ reader: ".vals" and ".inherits" are constant or missing
  get isConstant() {
    return (this.valuesProperty?.isConstant ?? true) && (this.inheritsProperty?.isConstant ?? true);
  }

  // NOTE Gives { matrix, inherits, values }. "matrix" is column-major (three.js Matrix4.fromArray).
  // "inherits" false: the transform does not use the transforms of its parents.
  getSample(index) {
    return this.readSample(createIndexSelector(index));
  }

  getSampleAtTime(time, mode = 'floor') {
    return this.readSample(createTimeSelector(time, mode));
  }

  readSample(selectIndex) {
    const { fullName } = this.object;
    const inherits = this.inheritsProperty
      ? readSampleValues(this.inheritsProperty, selectIndex)
      : null;
    const values =
      (this.valuesProperty && readSampleValues(this.valuesProperty, selectIndex)) ??
      new Float64Array();

    if (this.numChannels > 0 && values.length !== this.numChannels) {
      throw new AlembicError(
        `Transform "${fullName}" has ${values.length} channel values. Its ops have ${this.numChannels} channels.`
      );
    }

    // NOTE M = M(op 0) × M(op 1) × … × M(op n − 1): the last op is applied first (FORMAT.md 3.4)
    let matrix = identity();
    let offset = 0;

    for (const { type, numChannels } of this.ops) {
      matrix = multiply(matrix, getOpMatrix(type, values, offset));
      offset += numChannels;
    }

    return { matrix, inherits: inherits ? inherits[0] === 1 : true, values };
  }
}
