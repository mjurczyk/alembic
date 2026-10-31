import { AlembicError } from '../../core/AlembicError.js';
import { toHex } from '../../math/memory.js';
import { OgawaBlockReader } from './OgawaBlockReader.js';

const inlineMetadataIndex = 0xff;
const objectHashesSize = 32;
const timeSamplingTimeSize = 8;

const propertyTypes = ['compound', 'scalar', 'array', 'array'];
const scalarLikeArrayType = 3;

// NOTE "info" bit fields of a property header (FORMAT.md 2.7)
const propertyTypeMask = 0x3;
const sizeHintShift = 2;
const sizeHintMask = 0x3;
const podShift = 4;
const podMask = 0xf;
const hasTimeSamplingIndexFlag = 0x100;
const hasChangedIndicesFlag = 0x200;
const constantFlag = 0x800;
const extentShift = 12;
const extentMask = 0xff;
const metadataIndexShift = 20;
const metadataIndexMask = 0xff;

// NOTE Index 0 is the empty string. It is not stored (FORMAT.md 2.4).
export const readIndexedMetadata = (bytes) => {
  const reader = new OgawaBlockReader(bytes, 'Indexed metadata');
  const table = [''];

  while (!reader.isAtEnd) {
    const length = reader.readUint8('String length');

    table.push(reader.readText(length, `String ${table.length}`));
  }

  return table;
};

// NOTE Index 0xff: metadata is stored after the header (FORMAT.md 2.4)
const readMetadata = (reader, table, index, readLength) => {
  if (index === inlineMetadataIndex) {
    return reader.readText(readLength(), 'Metadata');
  }

  if (index >= table.length) {
    throw new AlembicError(
      `${reader.block}: metadata index ${index} is not in the indexed metadata (${table.length} strings).`
    );
  }

  return table[index];
};

// NOTE FORMAT.md section 4
export const readTimeSamplings = (bytes) => {
  const reader = new OgawaBlockReader(bytes, 'Time samplings');
  const timeSamplings = [];

  while (!reader.isAtEnd) {
    const maxNumSamples = reader.readUint32('Max sample count');
    const timePerCycle = reader.readFloat64('Time per cycle');
    const numTimes = reader.readUint32('Stored time count');

    if (numTimes * timeSamplingTimeSize > reader.remaining) {
      throw new AlembicError(
        `Time sampling ${
          timeSamplings.length
        } has ${numTimes} stored times. The block has space for ${Math.floor(
          reader.remaining / timeSamplingTimeSize
        )}.`
      );
    }

    const storedTimes = new Float64Array(numTimes);

    for (let index = 0; index < numTimes; index++) {
      storedTimes[index] = reader.readFloat64('Stored time');
    }

    timeSamplings.push({ timePerCycle, storedTimes, maxNumSamples });
  }

  return timeSamplings;
};

// NOTE Headers of the child objects, then 32 hash bytes. The hashes are not read (FORMAT.md 2.5.1).
export const readObjectHeaders = (bytes, table) => {
  if (bytes.byteLength < objectHashesSize) {
    throw new AlembicError(
      `Object header block has ${bytes.byteLength} bytes. It must have ${objectHashesSize} or more.`
    );
  }

  const reader = new OgawaBlockReader(
    bytes.subarray(0, bytes.byteLength - objectHashesSize),
    'Object headers'
  );
  const headers = [];

  while (!reader.isAtEnd) {
    const nameLength = reader.readUint32('Name length');

    if (nameLength === 0) {
      throw new AlembicError(`Object headers: object ${headers.length} has an empty name.`);
    }

    const name = reader.readText(nameLength, 'Name');
    const metadataIndex = reader.readUint8('Metadata index');
    const metadata = readMetadata(reader, table, metadataIndex, () =>
      reader.readUint32('Metadata length')
    );

    headers.push({ name, metadata });
  }

  return headers;
};

// NOTE FORMAT.md 2.7
const readPropertyHeader = (reader, table) => {
  const info = reader.readUint32('Info');
  const type = info & propertyTypeMask;
  const sizeHint = (info >> sizeHintShift) & sizeHintMask;
  const metadataIndex = (info >> metadataIndexShift) & metadataIndexMask;
  const header = { propertyType: propertyTypes[type] };

  if (sizeHint > 2) {
    throw new AlembicError(
      `${reader.block}: size hint ${sizeHint} is not valid (info ${toHex(info)}).`
    );
  }

  const readHint = (field) => reader.readHint(sizeHint, field);

  if (header.propertyType !== 'compound') {
    header.pod = (info >> podShift) & podMask;
    header.extent = (info >> extentShift) & extentMask;
    header.isScalarLike = type === scalarLikeArrayType;
    header.numSamples = readHint('Sample count');

    if (info & hasChangedIndicesFlag) {
      header.firstChangedIndex = readHint('First changed index');
      header.lastChangedIndex = readHint('Last changed index');
    } else if (info & constantFlag) {
      header.firstChangedIndex = 0;
      header.lastChangedIndex = 0;
    } else {
      header.firstChangedIndex = 1;
      header.lastChangedIndex = header.numSamples - 1;
    }

    header.timeSamplingIndex =
      info & hasTimeSamplingIndexFlag ? readHint('Time sampling index') : 0;
  }

  const nameLength = readHint('Name length');

  if (nameLength === 0) {
    throw new AlembicError(`${reader.block}: a property has an empty name.`);
  }

  header.name = reader.readText(nameLength, 'Name');
  header.metadata = readMetadata(reader, table, metadataIndex, () => readHint('Metadata length'));

  return header;
};

// NOTE Headers one after the other, with no count (FORMAT.md 2.7)
export const readPropertyHeaders = (bytes, table) => {
  const reader = new OgawaBlockReader(bytes, 'Property headers');
  const headers = [];

  while (!reader.isAtEnd) {
    headers.push(readPropertyHeader(reader, table));
  }

  return headers;
};
