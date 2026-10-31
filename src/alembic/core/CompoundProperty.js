import { ArrayProperty } from './ArrayProperty.js';
import { parseMetaData } from './MetaData.js';
import { ScalarProperty } from './ScalarProperty.js';

const propertyClasses = { scalar: ScalarProperty, array: ArrayProperty };

// NOTE Properties are read when first used.
// Source: readProperties() -> [{ name, propertyType, metadata, source }], plus sample header fields for scalar and array.
export class CompoundProperty {
  propertyType = 'compound';
  archive;
  parent;
  name;
  metadata;
  source;
  propertiesCache = null;

  constructor(archive, parent, { name, metadata, source }) {
    this.archive = archive;
    this.parent = parent;
    this.name = name;
    this.metadata = metadata;
    this.source = source;
  }

  get properties() {
    if (!this.propertiesCache) {
      this.propertiesCache = this.source.readProperties().map((header) => {
        const PropertyClass =
          header.propertyType === 'compound'
            ? CompoundProperty
            : propertyClasses[header.propertyType];

        return new PropertyClass(this.archive, this, {
          ...header,
          metadata: parseMetaData(header.metadata),
        });
      });
    }

    return this.propertiesCache;
  }

  get(name) {
    return this.properties.find((property) => property.name === name) ?? null;
  }
}
