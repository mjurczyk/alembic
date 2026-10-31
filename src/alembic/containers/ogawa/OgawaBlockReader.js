import { AlembicError } from '../../core/AlembicError.js';
import { littleEndian } from '../../math/memory.js';

const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

// NOTE The format does not store an encoding. /alembic uses UTF-8 (FORMAT.md 2.12).
export const decodeText = (bytes) => textDecoder.decode(bytes);

// NOTE Reads values one after the other from a data block. Values are not aligned (FORMAT.md 0.1).
export class OgawaBlockReader {
  bytes;
  view;
  block;
  position = 0;

  constructor(bytes, block) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.block = block;
  }

  get isAtEnd() {
    return this.position >= this.bytes.byteLength;
  }

  get remaining() {
    return this.bytes.byteLength - this.position;
  }

  advance(size, field) {
    const { position } = this;

    if (size > this.remaining) {
      throw new AlembicError(
        `${this.block}: ${field} at byte ${position} is outside the block (${this.bytes.byteLength} bytes).`
      );
    }

    this.position += size;

    return position;
  }

  readUint8(field) {
    return this.view.getUint8(this.advance(1, field));
  }

  readUint16(field) {
    return this.view.getUint16(this.advance(2, field), littleEndian);
  }

  readUint32(field) {
    return this.view.getUint32(this.advance(4, field), littleEndian);
  }

  readInt32(field) {
    return this.view.getInt32(this.advance(4, field), littleEndian);
  }

  readFloat64(field) {
    return this.view.getFloat64(this.advance(8, field), littleEndian);
  }

  // NOTE Size hint 0 = u8, 1 = u16, 2 = u32 (FORMAT.md 2.7)
  readHint(sizeHint, field) {
    if (sizeHint === 0) {
      return this.readUint8(field);
    }

    if (sizeHint === 1) {
      return this.readUint16(field);
    }

    return this.readUint32(field);
  }

  readText(length, field) {
    const position = this.advance(length, field);

    return decodeText(this.bytes.subarray(position, position + length));
  }
}
