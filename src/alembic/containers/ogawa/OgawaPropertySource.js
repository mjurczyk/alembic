import { AlembicError } from '../../core/AlembicError.js';
import { littleEndian, toHex, uint64Size } from '../../math/memory.js';

const sampleKeySize = 16;
const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);

// NOTE Repeats before the first change and after the last change are not stored (FORMAT.md 2.8)
const getNumStoredSamples = ({ numSamples, firstChangedIndex, lastChangedIndex }) => {
  if (numSamples === 0) {
    return 0;
  }

  if (firstChangedIndex === 0 && lastChangedIndex === 0) {
    return 1;
  }

  return lastChangedIndex - firstChangedIndex + 2;
};

// NOTE Empty data, or a 16-byte key and the values. Blocks of 1-15 bytes are not valid (FORMAT.md 2.10).
const getSampleValues = (data, offset) => {
  if (data.byteLength === 0) {
    return data;
  }

  if (data.byteLength < sampleKeySize) {
    throw new AlembicError(
      `Sample block at ${toHex(offset)} has ${
        data.byteLength
      } bytes. It must have 0 or ${sampleKeySize} or more.`
    );
  }

  return data.subarray(sampleKeySize);
};

// NOTE u64 per rank. Empty data: rank 1, count from the data size (FORMAT.md 2.10).
const getDimensions = (data, offset) => {
  if (data.byteLength === 0) {
    return null;
  }

  if (data.byteLength % uint64Size !== 0) {
    throw new AlembicError(
      `Dimensions block at ${toHex(offset)} has ${
        data.byteLength
      } bytes. This is not a multiple of 8.`
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const dimensions = [];

  for (let position = 0; position < data.byteLength; position += uint64Size) {
    const size = view.getBigUint64(position, littleEndian);

    if (size > maxSafeInteger) {
      throw new AlembicError(`Dimensions block at ${toHex(offset)} has a too large size.`);
    }

    dimensions.push(Number(size));
  }

  return dimensions;
};

// NOTE Scalar: one data child per stored sample (FORMAT.md 2.9).
// Array: data and dimensions children per stored sample (FORMAT.md 2.10).
export class OgawaPropertySource {
  group;
  isArray;
  numStoredSamples;
  firstChangedIndex;
  lastChangedIndex;

  constructor(group, header) {
    const { name, propertyType, numSamples, firstChangedIndex, lastChangedIndex } = header;
    const numStoredSamples = getNumStoredSamples(header);
    const isArray = propertyType === 'array';
    const numChildren = numStoredSamples * (isArray ? 2 : 1);

    if (numSamples > 0 && (numStoredSamples < 1 || numStoredSamples > numSamples)) {
      throw new AlembicError(
        `Property "${name}" has ${numSamples} samples, first changed index ${firstChangedIndex} and last changed index ${lastChangedIndex}. These are not valid.`
      );
    }

    if (group.numChildren !== numChildren) {
      throw new AlembicError(
        `Property "${name}" stores ${numStoredSamples} samples, so its group must have ${numChildren} children. The group at ${toHex(
          group.offset
        )} has ${group.numChildren}.`
      );
    }

    this.group = group;
    this.isArray = isArray;
    this.numStoredSamples = numStoredSamples;
    this.firstChangedIndex = firstChangedIndex;
    this.lastChangedIndex = lastChangedIndex;
  }

  // NOTE FORMAT.md 2.8
  getStoredIndex(index) {
    const { firstChangedIndex, lastChangedIndex } = this;

    if (index < firstChangedIndex || (firstChangedIndex === 0 && lastChangedIndex === 0)) {
      return 0;
    }

    if (index >= lastChangedIndex) {
      return lastChangedIndex - firstChangedIndex + 1;
    }

    return index - firstChangedIndex + 1;
  }

  // NOTE "id" is the block offset. Equal samples use one block (FORMAT.md 2.11).
  readSample(index) {
    const { group } = this;
    const storedIndex = this.getStoredIndex(index);

    if (!this.isArray) {
      const offset = group.getChildOffset(storedIndex);

      return { id: `${offset}`, bytes: getSampleValues(group.getData(storedIndex), offset) };
    }

    const dataIndex = storedIndex * 2;
    const dataOffset = group.getChildOffset(dataIndex);
    const dimensionsOffset = group.getChildOffset(dataIndex + 1);

    return {
      id: `${dataOffset}:${dimensionsOffset}`,
      bytes: getSampleValues(group.getData(dataIndex), dataOffset),
      dimensions: getDimensions(group.getData(dataIndex + 1), dimensionsOffset),
    };
  }
}
