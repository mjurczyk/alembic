// NOTE Binary arithmetic coder with adaptive bit models (FORMAT.md 4.5). 32-bit range, no carry: the high byte goes out
// when both ends of the range have the same high byte. A model is the 16-bit probability that the bit is 1.

const initialProbability = 32768;
const minProbability = 32;
const maxProbability = 65536 - 32;
// NOTE A model moves 1/32 of the way to each new bit
const adaptShift = 5;

export const createModels = (count) => new Uint16Array(count).fill(initialProbability);

// NOTE (high − low) × probability is less than 2^48, so the f64 product is exact
const split = (low, high, probability) => low + Math.floor(((high - low) * probability) / 65536);

const adapt = (models, model, bit) => {
  const probability = models[model];
  const next = bit
    ? probability + ((65536 - probability) >> adaptShift)
    : probability - (probability >> adaptShift);

  models[model] = Math.min(Math.max(next, minProbability), maxProbability);
};

export class BitEncoder {
  low = 0;
  high = 0xffffffff;
  bytes = new Uint8Array(1 << 16);
  length = 0;

  push(byte) {
    if (this.length === this.bytes.length) {
      const bytes = new Uint8Array(this.bytes.length * 2);

      bytes.set(this.bytes);
      this.bytes = bytes;
    }

    this.bytes[this.length++] = byte;
  }

  encode(bit, models, model) {
    const middle = split(this.low, this.high, models[model]);

    if (bit) {
      this.high = middle;
    } else {
      this.low = middle + 1;
    }

    adapt(models, model, bit);

    while (((this.low ^ this.high) & 0xff000000) === 0) {
      this.push(this.high >>> 24);
      this.low = (this.low << 8) >>> 0;
      this.high = ((this.high << 8) | 0xff) >>> 0;
    }
  }

  // NOTE "count" bits of "value", high bit first. Each bit position has its own model, after "offset".
  encodeBits(value, count, models, offset) {
    let node = 1;

    for (let bit = count - 1; bit >= 0; bit--) {
      const current = (value >>> bit) & 1;

      this.encode(current, models, offset + node);
      node = (node << 1) | current;
    }
  }

  finish() {
    for (let byte = 0; byte < 4; byte++) {
      this.push(this.low >>> 24);
      this.low = (this.low << 8) >>> 0;
    }

    return this.bytes.subarray(0, this.length);
  }
}

export class BitDecoder {
  low = 0;
  high = 0xffffffff;
  value = 0;
  position = 0;

  constructor(bytes) {
    this.bytes = bytes;

    for (let byte = 0; byte < 4; byte++) {
      this.value = ((this.value << 8) | this.next()) >>> 0;
    }
  }

  next() {
    return this.position < this.bytes.length ? this.bytes[this.position++] : 0;
  }

  decode(models, model) {
    const middle = split(this.low, this.high, models[model]);
    const bit = this.value <= middle ? 1 : 0;

    if (bit) {
      this.high = middle;
    } else {
      this.low = middle + 1;
    }

    adapt(models, model, bit);

    while (((this.low ^ this.high) & 0xff000000) === 0) {
      this.low = (this.low << 8) >>> 0;
      this.high = ((this.high << 8) | 0xff) >>> 0;
      this.value = ((this.value << 8) | this.next()) >>> 0;
    }

    return bit;
  }

  decodeBits(count, models, offset) {
    let node = 1;

    for (let bit = 0; bit < count; bit++) {
      node = (node << 1) | this.decode(models, offset + node);
    }

    return node - (1 << count);
  }
}
