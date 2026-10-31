import { HDF5Container } from '../containers/hdf5/HDF5Container.js';
import { OgawaContainer } from '../containers/ogawa/OgawaContainer.js';
import { AlembicError } from './AlembicError.js';

// NOTE Each container adapter has a name, matches(source) and async open(source).
// To add a container, add its adapter to this list.
class ContainersClass {
  adapters = [new OgawaContainer(), new HDF5Container()];

  find(source) {
    const adapter = this.adapters.find((container) => container.matches(source));

    if (!adapter) {
      const names = this.adapters.map(({ name }) => name).join(', ');

      throw new AlembicError(`File is not an Alembic archive. Known containers: ${names}.`);
    }

    return adapter;
  }
}

export const Containers = new ContainersClass();
