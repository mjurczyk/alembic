import { AlembicArchive } from './core/AlembicArchive.js';
import { AlembicError } from './core/AlembicError.js';
import { AlembicObject } from './core/AlembicObject.js';
import { AlembicReader } from './core/AlembicReader.js';
import { ArrayProperty } from './core/ArrayProperty.js';
import { CompoundProperty } from './core/CompoundProperty.js';
import { fetchBytes } from './core/fetchBytes.js';
import { ScalarProperty } from './core/ScalarProperty.js';
import { TimeSampling } from './core/TimeSampling.js';
import { GeomParam, GeomParamSample } from './schemas/GeomParam.js';
import { Points } from './schemas/Points.js';
import { PolyMesh } from './schemas/PolyMesh.js';
import { Xform } from './schemas/Xform.js';
import { BitDecoder, BitEncoder, createModels } from './wabc/arithmetic.js';
import { computeFlatNormals, computeSmoothNormals } from './wabc/normals.js';
import { decodePoints, encodePoints } from './wabc/points.js';
import {
  buildSurfaceMesh,
  cornerOffsets,
  decodeSurfaceSample,
  encodeSurfaceSample,
  getCellCase,
  getLocalEdge,
} from './wabc/surfaceCodec.js';
import { WabcFile } from './wabc/WabcFile.js';

// NOTE Coder parts of .wabc files, also used by the wabc CLI to write them
const WabcCodec = {
  BitDecoder,
  BitEncoder,
  createModels,
  buildSurfaceMesh,
  cornerOffsets,
  decodePoints,
  decodeSurfaceSample,
  encodePoints,
  encodeSurfaceSample,
  getCellCase,
  getLocalEdge,
};

export {
  AlembicArchive,
  AlembicError,
  AlembicObject,
  AlembicReader,
  ArrayProperty,
  CompoundProperty,
  GeomParam,
  GeomParamSample,
  Points,
  PolyMesh,
  ScalarProperty,
  TimeSampling,
  WabcCodec,
  WabcFile,
  Xform,
  computeFlatNormals,
  computeSmoothNormals,
};

// NOTE Network, HTTP and read errors give an AlembicError with the URL. "cause" has the original error.
export const loadAlembic = async (url) => {
  let source;

  try {
    source = await fetchBytes(url);
  } catch (error) {
    throw new AlembicError(`Could not load ${url}. ${error.message}`, { cause: error });
  }

  try {
    return await new AlembicReader().read(source);
  } catch (error) {
    throw new AlembicError(`Could not read ${url}. ${error.message}`, { cause: error });
  }
};

// NOTE A .wabc file from a URL, as a WabcFile. Errors as loadAlembic.
export const loadWabc = async (url) => {
  let source;

  try {
    source = await fetchBytes(url);
  } catch (error) {
    throw new AlembicError(`Could not load ${url}. ${error.message}`, { cause: error });
  }

  try {
    return new WabcFile(source);
  } catch (error) {
    throw new AlembicError(`Could not read ${url}. ${error.message}`, { cause: error });
  }
};
