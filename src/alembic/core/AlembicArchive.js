import { AlembicObject } from './AlembicObject.js';
import { parseMetaData } from './MetaData.js';
import { SampleCache } from './SampleCache.js';
import { TimeSampling } from './TimeSampling.js';

// NOTE Container-independent archive (FORMAT.md section 2). The container adapter gives the metadata string, time samplings and root object source.
export class AlembicArchive {
  metadata;
  timeSamplings;
  root;
  sampleCache = new SampleCache();

  constructor({ metadata, timeSamplings, root }) {
    this.metadata = parseMetaData(metadata);
    this.timeSamplings = timeSamplings.map((timeSampling) => new TimeSampling(timeSampling));

    // NOTE The top object has no header. Name "ABC" and archive metadata, as in the C++ reader (FORMAT.md 2.5).
    this.root = new AlembicObject(this, null, {
      name: 'ABC',
      metadata: this.metadata,
      source: root,
    });
  }

  findObject(fullName) {
    if (fullName === '/') {
      return this.root;
    }

    if (typeof fullName !== 'string' || !fullName.startsWith('/')) {
      return null;
    }

    let object = this.root;

    for (const name of fullName.slice(1).split('/')) {
      object = object.getChild(name);

      if (!object) {
        return null;
      }
    }

    return object;
  }
}
