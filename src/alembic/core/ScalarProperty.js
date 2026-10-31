import { AlembicError } from './AlembicError.js';
import { decodeValues } from './PlainOldData.js';
import { SampledProperty } from './SampledProperty.js';

// NOTE A sample is "extent" values (FORMAT.md 2.9)
export class ScalarProperty extends SampledProperty {
  propertyType = 'scalar';

  // NOTE Typed array (Array for string and wstring) of "extent" values
  getSample(index) {
    return this.readCachedSample(index, ({ bytes }) => {
      const values = decodeValues(bytes, this.plainOldDataType);
      const { extent } = this.dataType;

      if (values.length !== extent) {
        throw new AlembicError(
          `Sample ${index} of "${this.name}" has ${values.length} values. Extent is ${extent}.`
        );
      }

      return values;
    });
  }
}
