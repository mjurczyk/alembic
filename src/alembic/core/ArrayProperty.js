import { AlembicError } from './AlembicError.js';
import { decodeValues } from './PlainOldData.js';
import { SampledProperty } from './SampledProperty.js';

// NOTE A sample is a list of elements, each element is "extent" values (FORMAT.md 2.10)
export class ArrayProperty extends SampledProperty {
  propertyType = 'array';
  isScalarLike;

  constructor(archive, parent, header) {
    super(archive, parent, header);

    this.isScalarLike = header.isScalarLike;
  }

  // NOTE Gives { values, dimensions }. Values: typed array, or Array for strings.
  // Dimensions: element count per rank. No stored dimensions: rank 1.
  getSample(index) {
    return this.readCachedSample(index, ({ bytes, dimensions }) => {
      const values = decodeValues(bytes, this.plainOldDataType);
      const { extent } = this.dataType;

      if (values.length % extent !== 0) {
        throw new AlembicError(
          `Sample ${index} of "${this.name}" has ${values.length} values. This is not a multiple of extent ${extent}.`
        );
      }

      const numElements = values.length / extent;

      if (!dimensions) {
        return { values, dimensions: [numElements] };
      }

      const numDimensionElements = dimensions.reduce((product, size) => product * size, 1);

      if (numDimensionElements !== numElements) {
        throw new AlembicError(
          `Sample ${index} of "${this.name}" has ${numElements} elements. Its dimensions [${dimensions}] give ${numDimensionElements}.`
        );
      }

      return { values, dimensions };
    });
  }
}
