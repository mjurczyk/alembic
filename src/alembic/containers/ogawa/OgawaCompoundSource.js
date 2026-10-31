import { AlembicError } from '../../core/AlembicError.js';
import { toHex } from '../../math/memory.js';
import { readPropertyHeaders } from './OgawaHeaders.js';
import { OgawaPropertySource } from './OgawaPropertySource.js';

// NOTE [0]...[n-2] property groups, [n-1] property headers. No properties: empty group (FORMAT.md 2.6).
export class OgawaCompoundSource {
  group;
  metadataTable;

  constructor(group, metadataTable) {
    this.group = group;
    this.metadataTable = metadataTable;
  }

  readProperties() {
    const { group, metadataTable } = this;

    if (group.numChildren === 0) {
      return [];
    }

    const headers = readPropertyHeaders(group.getData(group.numChildren - 1), metadataTable);

    if (headers.length !== group.numChildren - 1) {
      throw new AlembicError(
        `Compound group at ${toHex(group.offset)} has ${
          group.numChildren - 1
        } property groups and ${headers.length} property headers.`
      );
    }

    return headers.map((header, index) => {
      const propertyGroup = group.getGroup(index);

      if (header.propertyType === 'compound') {
        return { ...header, source: new OgawaCompoundSource(propertyGroup, metadataTable) };
      }

      const source = new OgawaPropertySource(propertyGroup, header);

      return { ...header, isConstant: source.numStoredSamples <= 1, source };
    });
  }
}
