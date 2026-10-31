import { Containers } from './Containers.js';

export class AlembicReader {
  container = null;
  archive = null;

  // NOTE "archive" is an AlembicArchive. The container adapter makes it.
  async read(source) {
    if (!(source instanceof Uint8Array)) {
      throw new TypeError('AlembicReader source must be a Uint8Array.');
    }

    const container = Containers.find(source);

    this.archive = await container.open(source);
    this.container = container.name;

    return this;
  }
}
