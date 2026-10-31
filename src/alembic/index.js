import { AlembicArchive } from './core/AlembicArchive.js';
import { AlembicError } from './core/AlembicError.js';
import { AlembicObject } from './core/AlembicObject.js';
import { AlembicReader } from './core/AlembicReader.js';
import { ArrayProperty } from './core/ArrayProperty.js';
import { CompoundProperty } from './core/CompoundProperty.js';
import { ScalarProperty } from './core/ScalarProperty.js';
import { TimeSampling } from './core/TimeSampling.js';

export {
  AlembicArchive,
  AlembicError,
  AlembicObject,
  AlembicReader,
  ArrayProperty,
  CompoundProperty,
  ScalarProperty,
  TimeSampling,
};

export const loadAlembic = async (url) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new AlembicError(`Could not load ${url} (${response.status}).`);
  }

  const source = new Uint8Array(await response.arrayBuffer());

  return new AlembicReader().read(source);
};
