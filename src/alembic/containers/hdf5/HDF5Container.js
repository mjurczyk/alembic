import { AlembicError } from '../../core/AlembicError.js';
import { hasBytes } from '../../math/memory.js';

// NOTE "\x89HDF\r\n\x1a\n" at byte 0 (FORMAT.md section 5)
const hdf5Magic = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];

// NOTE Detects HDF5 only, to give a clear error. HDF5 is out of scope (FORMAT.md section 5).
export class HDF5Container {
  name = 'HDF5';

  matches(source) {
    return hasBytes(source, 0, hdf5Magic);
  }

  async open() {
    throw new AlembicError('File is an HDF5 Alembic archive. HDF5 archives are not supported.');
  }
}
