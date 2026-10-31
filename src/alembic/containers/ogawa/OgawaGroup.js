import { AlembicError } from '../../core/AlembicError.js';
import { toHex, uint64Size } from '../../math/memory.js';

// NOTE Child references are read only when a child is requested (FORMAT.md 1.2, 1.3)
export class OgawaGroup {
  reader;
  offset;
  numChildren;
  parent;
  depth;

  constructor(reader, offset, numChildren, parent) {
    this.reader = reader;
    this.offset = offset;
    this.numChildren = numChildren;
    this.parent = parent;
    this.depth = parent ? parent.depth + 1 : 0;
  }

  isChildGroup(index) {
    return !this.readChild(index).isData;
  }

  isChildData(index) {
    return this.readChild(index).isData;
  }

  getChildOffset(index) {
    return this.readChild(index).offset;
  }

  getGroup(index) {
    const { isData, offset } = this.readChild(index);

    if (isData) {
      throw new AlembicError(
        `Child ${index} of group at ${toHex(this.offset)} is data, not a group.`
      );
    }

    return this.reader.readGroup(offset, this);
  }

  getData(index) {
    const { isData, offset } = this.readChild(index);

    if (!isData) {
      throw new AlembicError(
        `Child ${index} of group at ${toHex(this.offset)} is a group, not data.`
      );
    }

    return this.reader.readData(offset);
  }

  readChild(index) {
    const { offset, numChildren } = this;

    if (!Number.isInteger(index) || index < 0 || index >= numChildren) {
      throw new AlembicError(
        `Group at ${toHex(offset)} has ${numChildren} children. Child ${index} does not exist.`
      );
    }

    return this.reader.readChildReference(offset + uint64Size + index * uint64Size);
  }
}
