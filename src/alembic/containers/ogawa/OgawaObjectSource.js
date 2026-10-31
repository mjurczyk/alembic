import { AlembicError } from '../../core/AlembicError.js';
import { toHex } from '../../math/memory.js';
import { OgawaCompoundSource } from './OgawaCompoundSource.js';
import { readObjectHeaders } from './OgawaHeaders.js';

// NOTE [0] top compound, [1]...[n-2] child objects, [n-1] child object headers (FORMAT.md 2.5)
export class OgawaObjectSource {
  group;
  metadataTable;

  constructor(group, metadataTable) {
    if (group.numChildren < 2) {
      throw new AlembicError(
        `Object group at ${toHex(group.offset)} has ${
          group.numChildren
        } children. It must have 2 or more.`
      );
    }

    this.group = group;
    this.metadataTable = metadataTable;
  }

  readChildren() {
    const { group, metadataTable } = this;
    const headers = readObjectHeaders(group.getData(group.numChildren - 1), metadataTable);

    if (headers.length !== group.numChildren - 2) {
      throw new AlembicError(
        `Object group at ${toHex(group.offset)} has ${group.numChildren - 2} child objects and ${
          headers.length
        } child headers.`
      );
    }

    return headers.map(({ name, metadata }, index) => ({
      name,
      metadata,
      source: new OgawaObjectSource(group.getGroup(index + 1), metadataTable),
    }));
  }

  readTopCompound() {
    return new OgawaCompoundSource(this.group.getGroup(0), this.metadataTable);
  }
}
