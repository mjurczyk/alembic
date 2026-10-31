import { AlembicError } from './AlembicError.js';
import { getPlainOldDataType } from './PlainOldData.js';

// NOTE Common part of scalar and array properties.
// Source: readSample(index) -> { id, bytes, dimensions }. Equal "id" means equal data.
export class SampledProperty {
  archive;
  parent;
  name;
  metadata;
  dataType;
  numSamples;
  timeSamplingIndex;
  timeSampling;
  isConstant;
  source;
  plainOldDataType;

  constructor(archive, parent, header) {
    const { name, metadata, pod, extent, numSamples, timeSamplingIndex, isConstant, source } =
      header;
    const timeSampling = archive.timeSamplings[timeSamplingIndex];

    if (!timeSampling) {
      throw new AlembicError(
        `Property "${name}" uses time sampling ${timeSamplingIndex}. The archive has ${archive.timeSamplings.length} time samplings.`
      );
    }

    if (!Number.isInteger(extent) || extent < 1) {
      throw new AlembicError(`Property "${name}" has extent ${extent}. Extent must be 1 or more.`);
    }

    this.archive = archive;
    this.parent = parent;
    this.name = name;
    this.metadata = metadata;
    this.plainOldDataType = getPlainOldDataType(pod);
    this.dataType = { pod: this.plainOldDataType.name, extent };
    this.numSamples = numSamples;
    this.timeSamplingIndex = timeSamplingIndex;
    this.timeSampling = timeSampling;
    this.isConstant = isConstant;
    this.source = source;
  }

  // NOTE Gives the decoded sample from the archive cache. Repeated samples give the same object.
  readCachedSample(index, decode) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.numSamples) {
      throw new RangeError(
        `Property "${this.name}" has ${this.numSamples} samples. Sample ${index} does not exist.`
      );
    }

    const sample = this.source.readSample(index);
    const { pod, extent } = this.dataType;

    return this.archive.sampleCache.get(`${this.propertyType}:${sample.id}:${pod}:${extent}`, () =>
      decode(sample)
    );
  }
}
