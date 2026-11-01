import { BitDecoder, BitEncoder, createModels } from './arithmetic.js';

// NOTE Points as a set (FORMAT.md 6.6): positions on a grid of "step", sorted by Morton key, stored as key gaps.
// The ids are not stored, so the order is free. The loader rebuilds the positions from the keys.

// NOTE Gap coding: the bit length of gap + 1 in unary (one model for each length), then the bits after the top bit
// (one model for each length and bit, for the first 8 bits; the other bits are nearly random and share models)
const maxLength = 64;
const modelBits = 8;

const createPointModels = () => ({
  lengths: createModels(maxLength + 1),
  bits: createModels(maxLength * (modelBits + 1)),
});

// NOTE Morton key: bit b of axis a goes to bit 3b + a. Up to 17 bits for each axis (51 bits, exact in f64).
const toKey = (cells) => {
  let key = 0;

  for (let bit = 0; bit < 17; bit++) {
    for (let axis = 0; axis < 3; axis++) {
      key += ((cells[axis] >> bit) & 1) * 2 ** (3 * bit + axis);
    }
  }

  return key;
};

const fromKey = (key, cells) => {
  cells[0] = 0;
  cells[1] = 0;
  cells[2] = 0;

  for (let bit = 0; bit < 17; bit++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = Math.floor(key / 2 ** (3 * bit + axis)) % 2;

      cells[axis] |= value << bit;
    }
  }

  return cells;
};

const bitLength = (value) => (value === 0 ? 0 : Math.floor(Math.log2(value)) + 1);

// NOTE Cell of each point: floor((p − min) / step). "min" is the smallest position of the sample.
export const encodePoints = (positions, step) => {
  const count = positions.length / 3;
  const min = [Infinity, Infinity, Infinity];

  for (let index = 0; index < positions.length; index++) {
    min[index % 3] = Math.min(min[index % 3], positions[index]);
  }

  const origin = min.map(Math.fround);
  const keys = new Float64Array(count);
  const cells = [0, 0, 0];

  for (let point = 0; point < count; point++) {
    for (let axis = 0; axis < 3; axis++) {
      cells[axis] = Math.max(0, Math.floor((positions[point * 3 + axis] - origin[axis]) / step));

      if (cells[axis] >= 2 ** 17) {
        throw new Error(`Points span more than 2^17 steps of ${step}.`);
      }
    }

    keys[point] = toKey(cells);
  }

  keys.sort();

  const models = createPointModels();
  const encoder = new BitEncoder();
  let last = 0;

  for (const key of keys) {
    const value = key - last + 1;
    const length = bitLength(value);

    last = key;

    for (let item = 1; item < length; item++) {
      encoder.encode(1, models.lengths, item);
    }

    encoder.encode(0, models.lengths, length);

    for (let bit = length - 2, position = 0; bit >= 0; bit--, position++) {
      const model = length * (modelBits + 1) + Math.min(position, modelBits);

      encoder.encode(Math.floor(value / 2 ** bit) % 2, models.bits, model);
    }
  }

  return { origin, count, bytes: encoder.finish() };
};

// NOTE Positions at the cell centres: origin + (cell + 0.5) × step
export const decodePoints = (bytes, count, origin, step) => {
  const models = createPointModels();
  const decoder = new BitDecoder(bytes);
  const positions = new Float32Array(count * 3);
  const cells = [0, 0, 0];
  let last = 0;

  for (let point = 0; point < count; point++) {
    let length = 1;

    while (decoder.decode(models.lengths, length)) {
      length++;
    }

    let value = 1;

    for (let bit = length - 2, position = 0; bit >= 0; bit--, position++) {
      const model = length * (modelBits + 1) + Math.min(position, modelBits);

      value = value * 2 + decoder.decode(models.bits, model);
    }

    last += value - 1;
    fromKey(last, cells);

    for (let axis = 0; axis < 3; axis++) {
      positions[point * 3 + axis] = origin[axis] + (cells[axis] + 0.5) * step;
    }
  }

  return positions;
};
