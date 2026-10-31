import { hasBytes } from '../../math/memory.js';
import { OgawaArchive, ogawaMagic } from './OgawaArchive.js';

export class OgawaContainer {
  name = 'Ogawa';

  matches(source) {
    return hasBytes(source, 0, ogawaMagic);
  }

  async open(source) {
    return new OgawaArchive(source);
  }
}
