import { AlembicArchive } from '../../core/AlembicArchive.js';
import { AlembicError } from '../../core/AlembicError.js';
import { hasBytes } from '../../math/memory.js';
import { OgawaArchive, ogawaMagic } from './OgawaArchive.js';
import { decodeText, OgawaBlockReader } from './OgawaBlockReader.js';
import { readIndexedMetadata, readTimeSamplings } from './OgawaHeaders.js';
import { OgawaObjectSource } from './OgawaObjectSource.js';

// NOTE Archive version, library version, top object, metadata, time samplings, indexed metadata (FORMAT.md 2.1)
const rootChildIsData = [true, true, false, true, true, true];
const supportedArchiveVersion = 0;

const readArchiveVersion = (bytes) => {
  const reader = new OgawaBlockReader(bytes, 'Archive version');
  const version = reader.readInt32('Version');

  if (!reader.isAtEnd || version !== supportedArchiveVersion) {
    throw new AlembicError(
      `Ogawa-Abc archive version is not supported. Only version ${supportedArchiveVersion} is supported.`
    );
  }
};

export class OgawaContainer {
  name = 'Ogawa';

  matches(source) {
    return hasBytes(source, 0, ogawaMagic);
  }

  // NOTE Maps the Ogawa tree to the container-independent archive (FORMAT.md section 2)
  async open(source) {
    const { root } = new OgawaArchive(source);

    if (root.numChildren < rootChildIsData.length) {
      throw new AlembicError(
        `Archive root group has ${root.numChildren} children. It must have ${rootChildIsData.length} or more.`
      );
    }

    rootChildIsData.forEach((isData, index) => {
      if (root.isChildData(index) !== isData) {
        throw new AlembicError(
          `Archive root child ${index} must be a ${isData ? 'data block' : 'group'}.`
        );
      }
    });

    readArchiveVersion(root.getData(0));

    const metadataTable = readIndexedMetadata(root.getData(5));

    return new AlembicArchive({
      metadata: decodeText(root.getData(3)),
      timeSamplings: readTimeSamplings(root.getData(4)),
      root: new OgawaObjectSource(root.getGroup(2), metadataTable),
    });
  }
}
