import { littleEndian } from '../math/memory.js';
import { AlembicError } from './AlembicError.js';

// NOTE Index is the POD value of the property header (FORMAT.md 2.12). String sizes are per unit.
export const PlainOldDataTypes = [
  { name: 'bool', size: 1 },
  { name: 'uint8', size: 1, ArrayType: Uint8Array, read: 'getUint8' },
  { name: 'int8', size: 1, ArrayType: Int8Array, read: 'getInt8' },
  { name: 'uint16', size: 2, ArrayType: Uint16Array, read: 'getUint16' },
  { name: 'int16', size: 2, ArrayType: Int16Array, read: 'getInt16' },
  { name: 'uint32', size: 4, ArrayType: Uint32Array, read: 'getUint32' },
  { name: 'int32', size: 4, ArrayType: Int32Array, read: 'getInt32' },
  { name: 'uint64', size: 8, ArrayType: BigUint64Array, read: 'getBigUint64' },
  { name: 'int64', size: 8, ArrayType: BigInt64Array, read: 'getBigInt64' },
  { name: 'float16', size: 2 },
  { name: 'float32', size: 4, ArrayType: Float32Array, read: 'getFloat32' },
  { name: 'float64', size: 8, ArrayType: Float64Array, read: 'getFloat64' },
  { name: 'string', size: 1 },
  { name: 'wstring', size: 4 },
];

const isLittleEndianHost = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// NOTE Strings are not changed. A byte order mark stays in the string.
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

const maxCodePoint = 0x10ffff;
const replacementCharacter = '�';

export const getPlainOldDataType = (pod) => {
  const type = PlainOldDataTypes[pod];

  if (!type) {
    throw new AlembicError(`POD type ${pod} is not valid. Valid POD types are 0-13.`);
  }

  return type;
};

const toDataView = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// NOTE IEEE 754 binary16: 1 sign bit, 5 exponent bits, 10 significand bits, bias 15 (FORMAT.md 2.12)
const decodeFloat16 = (bits) => {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;

  if (exponent === 0) {
    return sign * fraction * 2 ** -24;
  }

  if (exponent === 0x1f) {
    return fraction ? NaN : sign * Infinity;
  }

  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
};

// NOTE Each string ends with 0x00 (FORMAT.md 2.12)
const decodeStrings = (bytes) => {
  const strings = [];
  let start = 0;

  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 0) {
      strings.push(textDecoder.decode(bytes.subarray(start, index)));
      start = index + 1;
    }
  }

  if (start !== bytes.length) {
    throw new AlembicError('String sample does not end with a 0x00 byte.');
  }

  return strings;
};

// NOTE One int32 unit per wchar_t. Each string ends with unit 0 (FORMAT.md 2.12).
// UTF-16 surrogate pairs join when concatenated.
const decodeWideStrings = (bytes) => {
  const view = toDataView(bytes);
  const strings = [];
  let text = '';

  for (let position = 0; position < bytes.length; position += 4) {
    const unit = view.getUint32(position, littleEndian);

    if (unit === 0) {
      strings.push(text);
      text = '';
    } else {
      text += unit > maxCodePoint ? replacementCharacter : String.fromCodePoint(unit);
    }
  }

  if (text !== '') {
    throw new AlembicError('Wide string sample does not end with a 0 unit.');
  }

  return strings;
};

const decodeNumbers = (bytes, { name, size, ArrayType, read }) => {
  const count = bytes.length / size;

  // NOTE 0 is false, other values are true (FORMAT.md 2.12). Values become 0 or 1.
  if (name === 'bool') {
    return bytes.map((value) => (value === 0 ? 0 : 1));
  }

  if (name === 'float16') {
    const view = toDataView(bytes);
    const values = new Float32Array(count);

    for (let index = 0; index < count; index++) {
      values[index] = decodeFloat16(view.getUint16(index * size, littleEndian));
    }

    return values;
  }

  // NOTE Sample data is not aligned (FORMAT.md 0.1). The copy is aligned and has its own buffer.
  if (isLittleEndianHost) {
    return new ArrayType(bytes.slice().buffer, 0, count);
  }

  const view = toDataView(bytes);
  const values = new ArrayType(count);

  for (let index = 0; index < count; index++) {
    values[index] = view[read](index * size, littleEndian);
  }

  return values;
};

// NOTE Decodes all values in "bytes" (sample key not included). Strings give an Array, other types a typed array.
export const decodeValues = (bytes, type) => {
  if (bytes.length % type.size !== 0) {
    throw new AlembicError(
      `Sample has ${bytes.length} bytes. This is not a multiple of the ${type.name} size (${type.size} bytes).`
    );
  }

  if (type.name === 'string') {
    return decodeStrings(bytes);
  }

  if (type.name === 'wstring') {
    return decodeWideStrings(bytes);
  }

  return decodeNumbers(bytes, type);
};
