// NOTE Alembic data is little-endian (FORMAT.md 0.1)
export const littleEndian = true;

export const uint64Size = 8;

export const toHex = (value) => `0x${value.toString(16)}`;

export const hasBytes = (source, position, bytes) =>
  source.byteLength >= position + bytes.length &&
  bytes.every((byte, index) => source[position + index] === byte);
