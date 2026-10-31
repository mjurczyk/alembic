import { AlembicError } from './core/AlembicError.js';
import { AlembicReader } from './core/AlembicReader.js';

export { AlembicError, AlembicReader };

export const loadAlembic = async (url) => {
  const response = await fetch(url);

  if (!response.ok) {
    throw new AlembicError(`Could not load ${url} (${response.status}).`);
  }

  const source = new Uint8Array(await response.arrayBuffer());

  return new AlembicReader().read(source);
};
