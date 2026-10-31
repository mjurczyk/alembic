import { AlembicError } from '../core/AlembicError.js';

const timeIndexModes = ['floor', 'ceil', 'nearest'];

// NOTE Each property maps the index or time with its own time sampling.
// Indices are clamped to its samples, as in the C++ reader.
export const createIndexSelector = (index) => {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(`Sample index ${index} is not valid.`);
  }

  return (property) => Math.min(index, property.numSamples - 1);
};

export const createTimeSelector = (time, mode) => {
  if (typeof time !== 'number' || Number.isNaN(time)) {
    throw new RangeError(`Time ${time} is not valid.`);
  }

  if (!timeIndexModes.includes(mode)) {
    throw new RangeError(`Mode "${mode}" is not valid. Valid modes: ${timeIndexModes.join(', ')}.`);
  }

  return (property) => {
    const { timeSampling, numSamples } = property;

    if (mode === 'ceil') {
      return timeSampling.getCeilIndex(time, numSamples);
    }

    if (mode === 'nearest') {
      return timeSampling.getNearestIndex(time, numSamples);
    }

    return timeSampling.getSampleIndex(time, numSamples);
  };
};

// NOTE Values of the selected sample. Null if the property has no samples.
export const readSampleValues = (property, selectIndex) => {
  if (property.numSamples === 0) {
    return null;
  }

  const sample = property.getSample(selectIndex(property));

  return property.propertyType === 'array' ? sample.values : sample;
};

// NOTE No "extent": any extent
export const checkProperty = (property, { propertyType, pod, extent }) => {
  if (property.propertyType !== propertyType) {
    throw new AlembicError(
      `Property "${property.name}" is a ${property.propertyType} property. It must be a ${propertyType} property.`
    );
  }

  const { dataType } = property;

  if (pod && (dataType.pod !== pod || (extent !== undefined && dataType.extent !== extent))) {
    const actual = `${dataType.pod}[${dataType.extent}]`;
    const expected = `${pod}[${extent ?? 'n'}]`;

    throw new AlembicError(
      `Property "${property.name}" has type ${actual}. It must be ${expected}.`
    );
  }

  return property;
};

// NOTE Null if the property is not in the compound and not required
export const getSchemaProperty = (compound, name, { required = false, ...type }) => {
  const property = compound.get(name);

  if (!property) {
    if (required) {
      throw new AlembicError(`Compound "${compound.name}" has no "${name}" property.`);
    }

    return null;
  }

  return checkProperty(property, type);
};

// NOTE Schema compound of an object, for example ".geom" (FORMAT.md 3.1)
export const getSchemaCompound = (object, name) => {
  const compound = object.properties.get(name);

  if (!compound || compound.propertyType !== 'compound') {
    throw new AlembicError(
      `Object "${object.fullName}" has schema ${object.metadata.schema}, but no "${name}" compound property.`
    );
  }

  return compound;
};
