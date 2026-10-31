import { createSchema } from '../schemas/Schemas.js';
import { CompoundProperty } from './CompoundProperty.js';
import { parseMetaData } from './MetaData.js';

// NOTE Children and properties are read when first used.
// Source: readChildren() -> [{ name, metadata, source }], readTopCompound() -> compound source.
export class AlembicObject {
  archive;
  parent;
  name;
  fullName;
  metadata;
  source;
  childrenCache = null;
  propertiesCache = null;
  schemaCache = undefined;

  constructor(archive, parent, { name, metadata, source }) {
    this.archive = archive;
    this.parent = parent;
    this.name = name;
    this.metadata = metadata;
    this.source = source;

    if (!parent) {
      this.fullName = '/';
    } else {
      this.fullName = parent.parent ? `${parent.fullName}/${name}` : `/${name}`;
    }
  }

  get children() {
    if (!this.childrenCache) {
      this.childrenCache = this.source.readChildren().map(
        ({ name, metadata, source }) =>
          new AlembicObject(this.archive, this, {
            name,
            metadata: parseMetaData(metadata),
            source,
          })
      );
    }

    return this.childrenCache;
  }

  // NOTE The top compound has no header. Name "" and object metadata, as in the C++ reader.
  get properties() {
    if (!this.propertiesCache) {
      this.propertiesCache = new CompoundProperty(this.archive, null, {
        name: '',
        metadata: this.metadata,
        source: this.source.readTopCompound(),
      });
    }

    return this.propertiesCache;
  }

  // NOTE PolyMesh, Xform or Points. Null for other schemas.
  get schema() {
    if (this.schemaCache === undefined) {
      this.schemaCache = createSchema(this);
    }

    return this.schemaCache;
  }

  getChild(name) {
    return this.children.find((child) => child.name === name) ?? null;
  }
}
