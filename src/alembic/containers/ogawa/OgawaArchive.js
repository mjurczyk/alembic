import { AlembicError } from '../../core/AlembicError.js';
import { hasBytes, littleEndian, toHex, uint64Size } from '../../math/memory.js';
import { OgawaGroup } from './OgawaGroup.js';

const headerSize = 16;
export const ogawaMagic = [0x4f, 0x67, 0x61, 0x77, 0x61];
const frozenFlag = 0xff;
const ogawaVersion = [0x00, 0x01];

const dataFlag = 1n << 63n;
const offsetMask = dataFlag - 1n;
const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER);

// NOTE Limits the walk in malformed files (FORMAT.md 1.6). The demo files have 7 levels.
const maxGroupDepth = 4096;

// NOTE Ogawa container (FORMAT.md section 1). The constructor reads only the header and root group.
export class OgawaArchive {
  source;
  view;
  root;

  constructor(source) {
    if (!(source instanceof Uint8Array)) {
      throw new TypeError('OgawaArchive source must be a Uint8Array.');
    }

    this.source = source;
    this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);

    this.validateHeader();

    const rootOffset = this.readUint64(8, 'Root group offset');

    if (rootOffset < headerSize) {
      throw new AlembicError(`Root group offset ${toHex(rootOffset)} points into the file header.`);
    }

    this.root = this.readGroup(rootOffset, null);
  }

  get byteLength() {
    return this.source.byteLength;
  }

  validateHeader() {
    const { source } = this;

    if (source.byteLength < headerSize) {
      throw new AlembicError(
        `File is too short for an Ogawa header (${source.byteLength} bytes, ${headerSize} needed).`
      );
    }

    if (!hasBytes(source, 0, ogawaMagic)) {
      throw new AlembicError('File is not an Ogawa archive (bytes 0-4 are not "Ogawa").');
    }

    if (source[5] !== frozenFlag) {
      const flag = toHex(source[5]);

      throw new AlembicError(
        `Ogawa file was not closed by its writer (frozen flag ${flag}, not 0xff).`
      );
    }

    if (!hasBytes(source, 6, ogawaVersion)) {
      throw new AlembicError(
        `Ogawa version {${source[6]}, ${source[7]}} is not supported. Only {0, 1} is supported.`
      );
    }
  }

  // NOTE u64 values above Number.MAX_SAFE_INTEGER cannot be exact as a Number (FORMAT.md 0.1)
  readUint64(position, field) {
    this.assertInFile(position, uint64Size, field);

    const value = this.view.getBigUint64(position, littleEndian);

    if (value > maxSafeInteger) {
      throw new AlembicError(`${field} at ${toHex(position)} is too large (${toHex(value)}).`);
    }

    return Number(value);
  }

  // NOTE Bit 63 is the data flag, bits 0-62 are the offset (FORMAT.md 1.2)
  readChildReference(position) {
    this.assertInFile(position, uint64Size, 'Child reference');

    const word = this.view.getBigUint64(position, littleEndian);
    const offset = word & offsetMask;

    if (offset > maxSafeInteger) {
      throw new AlembicError(`Child offset at ${toHex(position)} is too large (${toHex(offset)}).`);
    }

    return { isData: (word & dataFlag) !== 0n, offset: Number(offset) };
  }

  readGroup(offset, parent) {
    // NOTE Offset 0 is the empty group. Nothing is on disk for it (FORMAT.md 1.2).
    if (offset === 0) {
      return new OgawaGroup(this, 0, 0, parent);
    }

    this.assertStructureOffset(offset, 'Group');

    if (parent) {
      if (parent.depth + 1 > maxGroupDepth) {
        throw new AlembicError(
          `Group at ${toHex(offset)} is deeper than ${maxGroupDepth} levels. File is not valid.`
        );
      }

      for (let ancestor = parent; ancestor; ancestor = ancestor.parent) {
        if (ancestor.offset === offset) {
          throw new AlembicError(
            `Group at ${toHex(offset)} is its own ancestor. File is not valid.`
          );
        }
      }
    }

    const numChildren = this.readUint64(offset, 'Group child count');
    const maxChildren = Math.floor((this.byteLength - offset - uint64Size) / uint64Size);

    if (numChildren > maxChildren) {
      const hexOffset = toHex(offset);

      throw new AlembicError(
        `Group at ${hexOffset} has ${numChildren} children, but the file has space for ${maxChildren}.`
      );
    }

    return new OgawaGroup(this, offset, numChildren, parent);
  }

  // NOTE Returns a view into the source. Values are not aligned, use a DataView (FORMAT.md 0.1).
  readData(offset) {
    // NOTE Offset 0 is the empty data block. Nothing is on disk for it (FORMAT.md 1.2).
    if (offset === 0) {
      return this.source.subarray(0, 0);
    }

    this.assertStructureOffset(offset, 'Data block');

    const size = this.readUint64(offset, 'Data block size');
    const start = offset + uint64Size;
    const bytesAfter = this.byteLength - start;

    if (size > bytesAfter) {
      throw new AlembicError(
        `Data block at ${toHex(
          offset
        )} has ${size} bytes, but the file has ${bytesAfter} bytes after it.`
      );
    }

    return this.source.subarray(start, start + size);
  }

  assertStructureOffset(offset, structure) {
    if (offset < headerSize) {
      throw new AlembicError(`${structure} offset ${toHex(offset)} points into the file header.`);
    }
  }

  assertInFile(position, size, field) {
    const { byteLength } = this;

    if (position + size > byteLength) {
      throw new AlembicError(
        `${field} at ${toHex(
          position
        )} is outside the file (${byteLength} bytes). File is truncated or not valid.`
      );
    }
  }
}
