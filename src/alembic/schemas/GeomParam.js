import { AlembicError } from '../core/AlembicError.js';
import {
  checkProperty,
  createIndexSelector,
  createTimeSelector,
  getSchemaProperty,
  readSampleValues,
} from './utils.js';

// NOTE "geoScope" metadata values. No key: constant (FORMAT.md 3.3).
const scopes = {
  con: 'constant',
  uni: 'uniform',
  var: 'varying',
  vtx: 'vertex',
  fvr: 'facevarying',
};

export class GeomParamSample {
  scope;
  extent;
  values;
  indices;

  constructor({ scope, extent, values, indices }) {
    this.scope = scope;
    this.extent = extent;
    this.values = values;
    this.indices = indices;
  }

  // NOTE value[j] = values[indices[j]] (FORMAT.md 3.3). Always a new array.
  // No indices: a copy of "values", as in the C++ reader.
  getExpandedValues() {
    const { values, indices, extent } = this;

    if (!indices || indices.length === 0) {
      return values.slice();
    }

    const numValues = values.length / extent;
    const expanded = new values.constructor(indices.length * extent);

    for (let item = 0; item < indices.length; item++) {
      const index = indices[item];

      if (index >= numValues) {
        throw new AlembicError(
          `Geometry parameter index ${index} is not valid. There are ${numValues} values.`
        );
      }

      for (let component = 0; component < extent; component++) {
        expanded[item * extent + component] = values[index * extent + component];
      }
    }

    return expanded;
  }
}

// NOTE Not indexed: one array property. Indexed: compound with ".vals" and ".indices" (FORMAT.md 3.3).
export class GeomParam {
  name;
  metadata;
  scope;
  isIndexed;
  extent;
  valuesProperty;
  indicesProperty = null;

  constructor(property, { pod, extent }) {
    this.name = property.name;
    this.metadata = property.metadata;
    this.extent = extent;

    const geoScope = property.metadata.geoScope;

    this.scope = geoScope === undefined ? 'constant' : scopes[geoScope] ?? 'unknown';

    if (property.propertyType === 'compound') {
      this.isIndexed = true;
      this.valuesProperty = getSchemaProperty(property, '.vals', {
        propertyType: 'array',
        pod,
        extent,
        required: true,
      });
      this.indicesProperty = getSchemaProperty(property, '.indices', {
        propertyType: 'array',
        pod: 'uint32',
        extent: 1,
        required: true,
      });
    } else {
      this.isIndexed = false;
      this.valuesProperty = checkProperty(property, { propertyType: 'array', pod, extent });
    }
  }

  // NOTE As in the C++ reader: indexed parameters use the samples and time sampling of ".indices"
  get numSamples() {
    const { valuesProperty, indicesProperty } = this;

    return indicesProperty
      ? Math.max(valuesProperty.numSamples, indicesProperty.numSamples)
      : valuesProperty.numSamples;
  }

  get timeSampling() {
    return (this.indicesProperty ?? this.valuesProperty).timeSampling;
  }

  get isConstant() {
    return this.valuesProperty.isConstant && (this.indicesProperty?.isConstant ?? true);
  }

  getSample(index) {
    return this.readSample(createIndexSelector(index));
  }

  getSampleAtTime(time, mode = 'floor') {
    return this.readSample(createTimeSelector(time, mode));
  }

  readSample(selectIndex) {
    const values = readSampleValues(this.valuesProperty, selectIndex);

    if (!values) {
      return null;
    }

    const indices = this.indicesProperty
      ? readSampleValues(this.indicesProperty, selectIndex)
      : null;

    if (this.isIndexed && !indices) {
      return null;
    }

    return new GeomParamSample({ scope: this.scope, extent: this.extent, values, indices });
  }
}
