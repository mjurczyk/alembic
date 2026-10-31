import { GeomParam } from './GeomParam.js';
import {
  createIndexSelector,
  createTimeSelector,
  getSchemaCompound,
  getSchemaProperty,
  readSampleValues,
} from './utils.js';

// NOTE AbcGeom_Points_v1, compound ".geom" (FORMAT.md 3.5)
export class Points {
  type = 'Points';
  object;
  positionsProperty;
  idsProperty;
  velocitiesProperty;
  selfBoundsProperty;
  widths = null;

  constructor(object) {
    const compound = getSchemaCompound(object, '.geom');

    this.object = object;
    this.positionsProperty = getSchemaProperty(compound, 'P', {
      propertyType: 'array',
      pod: 'float32',
      extent: 3,
      required: true,
    });
    this.idsProperty = getSchemaProperty(compound, '.pointIds', {
      propertyType: 'array',
      pod: 'uint64',
      extent: 1,
      required: true,
    });
    this.velocitiesProperty = getSchemaProperty(compound, '.velocities', {
      propertyType: 'array',
      pod: 'float32',
      extent: 3,
    });
    this.selfBoundsProperty = getSchemaProperty(compound, '.selfBnds', {
      propertyType: 'scalar',
      pod: 'float64',
      extent: 6,
    });

    const widths = compound.get('.widths');

    if (widths) {
      this.widths = new GeomParam(widths, { pod: 'float32', extent: 1 });
    }
  }

  get numSamples() {
    return this.positionsProperty.numSamples;
  }

  get timeSampling() {
    return this.positionsProperty.timeSampling;
  }

  // NOTE As in the C++ reader: positions and ids do not change
  get isConstant() {
    return this.positionsProperty.isConstant && this.idsProperty.isConstant;
  }

  // NOTE Gives null if the points have no samples. "ids" is a BigUint64Array.
  getSample(index) {
    return this.readSample(createIndexSelector(index));
  }

  getSampleAtTime(time, mode = 'floor') {
    return this.readSample(createTimeSelector(time, mode));
  }

  readSample(selectIndex) {
    const positions = readSampleValues(this.positionsProperty, selectIndex);

    if (!positions) {
      return null;
    }

    return {
      positions,
      ids: readSampleValues(this.idsProperty, selectIndex) ?? new BigUint64Array(),
      velocities: this.velocitiesProperty
        ? readSampleValues(this.velocitiesProperty, selectIndex)
        : null,
      widths: this.widths?.readSample(selectIndex) ?? null,
      selfBounds: this.selfBoundsProperty
        ? readSampleValues(this.selfBoundsProperty, selectIndex)
        : null,
    };
  }
}
