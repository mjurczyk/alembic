import { closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { brotliCompressSync, constants as zlibConstants, deflateSync } from 'node:zlib';
import { AlembicReader, WabcCodec } from 'alembic';
import { createLayout, decodePositions, encodeGeometry, encodeLayer } from './encode.js';
import { readFileInParts, getSha256 } from './files.js';
import { areEqual, identity, invert, isIdentity, multiply, toF32 } from './matrices.js';
import {
  countNormalErrors,
  createMeshLayout,
  decideNormals,
  fitsLayout,
  getMeshValues,
  getPointsValues,
  sortPoints,
} from './meshes.js';
import { analyseSurface, createVolume, detectGrid, getNodeRange, learnCases } from './surface.js';

const { encodePoints, encodeSurfaceSample } = WabcCodec;
import {
  createTimeSamplingTable,
  getTime,
  selectSamples,
  toHeaderTimeSampling,
} from './timeSamplings.js';

const writer = 'wabc 0.0.0';
// NOTE Largest layer width. The writer selects the width (FORMAT.md 3.10).
const maxLayerWidth = 4096;
// NOTE Bytes copied from the data file to the output in one part
const copyPartSize = 64 << 20;

const compressors = {
  deflate: (bytes) => deflateSync(bytes),
  brotli: (bytes) =>
    brotliCompressSync(bytes, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
      },
    }),
};

const writeAll = (file, bytes) => {
  for (let written = 0; written < bytes.length; ) {
    written += writeSync(file, bytes, written, bytes.length - written);
  }
};

// NOTE Compressed chunks go to a data file in the order of FORMAT.md section 7. The header comes before them at the end.
class ChunkWriter {
  offset = 0;

  constructor(path, compression) {
    this.compress = compressors[compression];
    this.file = openSync(path, 'w');
  }

  write(bytes) {
    const compressed = this.compress(bytes);
    const reference = { offset: this.offset, length: compressed.length };

    writeAll(this.file, compressed);
    this.offset += compressed.length;

    return reference;
  }

  // NOTE Closes once: a file descriptor number can be used again by other files
  close() {
    if (this.file !== null) {
      closeSync(this.file);
      this.file = null;
    }
  }
}

const getType = (object) =>
  ({ PolyMesh: 'mesh', Points: 'points' }[object.schema?.type] ?? 'group');

// NOTE True if a sample of the schema can be different from the first sample
const isAnimated = (schema) => {
  if (!schema || schema.numSamples <= 1) {
    return false;
  }

  const parameters = [schema.normals, schema.uvs, schema.widths].filter(Boolean);

  return !schema.isConstant || parameters.some((parameter) => !parameter.isConstant);
};

// NOTE Objects in tree order (parents first), without "/". "objects": paths, with the objects below and above them.
const collectEntries = (root, objects) => {
  const entries = [];
  const isSelected = (path) =>
    !objects ||
    objects.some(
      (selected) =>
        path === selected || path.startsWith(`${selected}/`) || selected.startsWith(`${path}/`)
    );
  const visit = (object, parent) => {
    if (!isSelected(object.fullName)) {
      return;
    }

    const entry = { object, parent, index: entries.length };

    entries.push(entry);
    object.children.forEach((child) => visit(child, entry));
  };

  root.children.forEach((child) => visit(child, null));

  return entries;
};

// NOTE Time range of the sample range. Its sample indices are the samples of the animated schema with the most samples.
const getTimeRange = (entries, samples) => {
  if (!samples) {
    return null;
  }

  const schemas = entries
    .map(({ object }) => object.schema)
    .filter(
      (schema) =>
        schema &&
        schema.numSamples > 1 &&
        (schema.type === 'Xform' ? !schema.isConstant : isAnimated(schema))
    );
  const longest = schemas.reduce(
    (best, schema) => (!best || schema.numSamples > best.numSamples ? schema : best),
    null
  );

  if (!longest) {
    return null;
  }

  const lastIndex = longest.timeSampling.getLastIndex(longest.numSamples);
  const { first } = samples;
  const last = Math.min(samples.last ?? lastIndex, lastIndex);

  if (first > lastIndex) {
    throw new Error(
      `Sample ${first} does not exist. "${longest.object.fullName}" has ${lastIndex + 1} samples.`
    );
  }

  return {
    start: longest.timeSampling.getSampleTime(first),
    end: longest.timeSampling.getSampleTime(last),
  };
};

const getXformSample = (schema, time) =>
  schema.numSamples > 1 ? schema.getSampleAtTime(time) : schema.getSample(0);

// NOTE World matrix of an entry at a time, with the ".inherits" rule (alembic FORMAT.md 3.4)
const getWorldMatrix = (entry, time) => {
  const parentMatrix = entry.parent ? getWorldMatrix(entry.parent, time) : identity();
  const { schema } = entry.object;

  if (schema?.type !== 'Xform') {
    return parentMatrix;
  }

  const sample = getXformSample(schema, time);

  if (!sample) {
    return parentMatrix;
  }

  return sample.inherits
    ? multiply(Array.from(sample.matrix), parentMatrix)
    : Array.from(sample.matrix);
};

// NOTE Animated Xform with the most samples, of the entry and its parents
const getLongestXform = (entry) => {
  let longest = null;

  for (let item = entry; item; item = item.parent) {
    const { schema } = item.object;

    if (schema?.type === 'Xform' && schema.numSamples > 1 && !schema.isConstant) {
      longest = !longest || schema.numSamples > longest.numSamples ? schema : longest;
    }
  }

  return longest;
};

// NOTE Matrix values of each sample, and the source time sampling and its selected indices (FORMAT.md 8.2)
const getMatrixSamples = (entry, space, range) => {
  const { schema } = entry.object;
  const isXform = schema?.type === 'Xform';
  const ownSamples = isXform && schema.numSamples > 1 && !schema.isConstant;

  if (space === 'local' && !isXform) {
    return null;
  }

  // NOTE A local matrix with ".inherits" false changes with its parents. It uses the samples of the longest Xform.
  const usesParents =
    space === 'world' ||
    (isXform &&
      schema.inheritsProperty &&
      [...Array(schema.numSamples).keys()].some((index) => !schema.getSample(index).inherits));
  const source = usesParents ? getLongestXform(entry) : ownSamples ? schema : null;

  if (!source) {
    const time = range?.start ?? 0;
    const matrix = space === 'world' ? getWorldMatrix(entry, time) : getLocalMatrix(entry, time);

    return { matrices: [matrix], timeSampling: null, indices: [0] };
  }

  const indices = selectSamples(source.timeSampling, source.numSamples, range);
  const matrices = indices.map((index) => {
    const time = source.timeSampling.getSampleTime(index);

    return space === 'world' ? getWorldMatrix(entry, time) : getLocalMatrix(entry, time);
  });

  return { matrices, timeSampling: source.timeSampling, indices };
};

// NOTE Local matrix. ".inherits" false: local × inverse(world(parent)), so that the world matrix is "local".
const getLocalMatrix = (entry, time) => {
  const sample = getXformSample(entry.object.schema, time);

  if (!sample) {
    return identity();
  }

  const matrix = Array.from(sample.matrix);

  if (sample.inherits || !entry.parent) {
    return matrix;
  }

  const inverse = invert(getWorldMatrix(entry.parent, time));

  return inverse ? multiply(matrix, inverse) : matrix;
};

const createMatrixTrack = (entry, options, range, timeSamplings, chunks) => {
  const samples = getMatrixSamples(entry, options.space, range);

  if (!samples) {
    return null;
  }

  const matrices = samples.matrices.map(toF32);
  const allEqual = matrices.every((matrix) => areEqual(matrix, matrices[0]));

  if (allEqual) {
    return isIdentity(matrices[0]) ? null : { numSamples: 1, values: matrices[0] };
  }

  const track = {
    numSamples: matrices.length,
    timeSampling: timeSamplings.add(toHeaderTimeSampling(samples.timeSampling, samples.indices)),
  };
  const data = new Float32Array(matrices.length * 16);

  matrices.forEach((matrix, index) => data.set(matrix, index * 16));
  chunks.push({
    bytes: () => new Uint8Array(data.buffer),
    assign: (reference) => (track.chunk = reference),
  });

  return track;
};

// NOTE "normals": the normal attribute is stored only if the loader cannot calculate the normals (FORMAT.md 8.4)
const getLayoutFormats = (type, options, sample, normals) => {
  const position = options.bits === 16 ? 'n16x4' : 'f32x3';
  const normal = { 8: 'n8x4', 16: 'n16x4', 32: 'f32x3' }[options.normalBits];

  if (type === 'mesh') {
    return [
      ['position', position],
      ...(normals === 'stored' ? [['normal', normal]] : []),
      ...(sample?.uvs ? [['uv', options.bits === 16 ? 'n16x2' : 'f32x2']] : []),
    ];
  }

  return [
    ['position', position],
    ...(sample?.widths ? [['width', options.bits === 16 ? 'n16x2' : 'f32']] : []),
  ];
};

// NOTE Values of one sample. Mesh layouts of "swap" samples are made for each sample.
// Without stored normals, N does not split points into vertices.
const readSampleValues = (type, schema, path, index, layout = null, normals = 'stored') => {
  const source = schema.numSamples > 0 ? schema.getSample(index) : null;
  const sample =
    source && type === 'mesh' && normals !== 'stored' ? { ...source, normals: null } : source;

  if (!sample) {
    return { vertexCount: 0, values: { position: [], normal: [], uv: [], width: [] }, index: null };
  }

  if (type === 'points') {
    return { ...getPointsValues(sample, path), index: null };
  }

  const meshLayout = layout ?? createMeshLayout(sample, path);

  return {
    vertexCount: meshLayout.vertexCount,
    values: getMeshValues(meshLayout, sample, normals === 'stored'),
    index: meshLayout.index,
  };
};

// NOTE "vertex" mode: the vertices of all samples are the same (FORMAT.md 8.4, 8.5)
const canUseVertexMode = (type, schema) => {
  if (type === 'points') {
    return schema.idsProperty.isConstant && (!schema.widths || schema.widths.isConstant);
  }

  const { faceIndicesProperty, faceCountsProperty, normals, uvs } = schema;

  return (
    faceIndicesProperty.isConstant &&
    faceCountsProperty.isConstant &&
    (!uvs || uvs.isConstant) &&
    (!normals?.indicesProperty || normals.indicesProperty.isConstant)
  );
};

// NOTE Base geometry: the middle of the range of each position value over all samples (FORMAT.md 6.2).
// Null if a sample has other vertices than the first sample.
const createVertexTrackData = (type, schema, path, indices, normals) => {
  const source = schema.getSample(indices[0]);
  const firstSample =
    type === 'mesh' && normals !== 'stored' ? { ...source, normals: null } : source;
  const layout = type === 'mesh' ? createMeshLayout(firstSample, path) : null;
  const first = readSampleValues(type, schema, path, indices[0], layout, normals);
  const count = first.values.position.length;
  const min = Float64Array.from(first.values.position);
  const max = Float64Array.from(first.values.position);

  for (const index of indices.slice(1)) {
    const sample = schema.getSample(index);
    const fits =
      type === 'mesh'
        ? fitsLayout(layout, normals === 'stored' ? sample : { ...sample, normals: null })
        : sample.positions.length === firstSample.positions.length;

    if (!fits) {
      return null;
    }

    const { position } = readSampleValues(type, schema, path, index, layout, normals).values;

    for (let item = 0; item < count; item++) {
      min[item] = Math.min(min[item], position[item]);
      max[item] = Math.max(max[item], position[item]);
    }
  }

  const middle = new Float64Array(count);

  for (let item = 0; item < count; item++) {
    middle[item] = (min[item] + max[item]) / 2;
  }

  return { layout, first, basePositions: middle };
};

// NOTE Grid surface track (FORMAT.md 6.5): signs of the grid nodes and t of the crossing edges, for all samples in
// order. Null if a sample is not a surface on one grid, or a cell case has two triangulations.
const createSurfaceTrack = (schema, indices, tBits) => {
  const picks = [
    ...new Set(
      [0, 0.25, 0.5, 0.75, 1].map((part) => indices[Math.round(part * (indices.length - 1))])
    ),
  ];
  const grid = detectGrid(picks.map((index) => schema.getSample(index)));

  if (!grid) {
    return null;
  }

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (const index of indices) {
    const range = getNodeRange(schema.getSample(index).positions, grid);

    if (!range) {
      return null;
    }

    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], range.min[axis]);
      max[axis] = Math.max(max[axis], range.max[axis]);
    }
  }

  const volume = createVolume({ min, max });

  // NOTE The sign of nodes with a point on them is not in the file. One of the 2 choices must fit all samples.
  for (const cornerSign of [0, 1]) {
    const table = new Map();
    const needed = new Set();
    const chunks = [];
    let previous = new Uint8Array(volume.count);

    for (const index of indices) {
      const result = analyseSurface(schema.getSample(index), grid, volume, cornerSign);

      if (result.error || !learnCases(table, result.cases)) {
        chunks.length = 0;
        break;
      }

      result.neededCases.forEach((cellCase) => needed.add(cellCase));
      chunks.push({
        bytes: encodeSurfaceSample(result.signs, previous, volume.size, result.tValues, tBits),
        vertexCount: result.vertexCount,
        triangleCount: result.triangleCount,
      });
      previous = result.signs;
    }

    if (chunks.length === indices.length && [...needed].every((cellCase) => table.has(cellCase))) {
      const cases = [...table.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([cellCase, triangles]) => [
          cellCase,
          triangles
            ? triangles.split(' ').flatMap((triangle) => triangle.split(',').map(Number))
            : [],
        ]);

      return {
        grid,
        volume: { first: volume.first, size: volume.size },
        table: Object.fromEntries(cases),
        chunks,
      };
    }
  }

  return null;
};

// NOTE The width of all points of all samples, or null if the widths are not all equal
const getConstantWidth = (schema, indices) => {
  let width = null;

  for (const index of indices) {
    const widths = schema.getSample(index)?.widths?.getExpandedValues();

    if (!widths || widths.length === 0) {
      return null;
    }

    for (const value of widths) {
      if (width === null) {
        width = value;
      } else if (value !== width) {
        return null;
      }
    }
  }

  return width > 0 ? width : null;
};

const createGeometryTrack = (entry, options, range, timeSamplings, chunks, events) => {
  const { object, index: nodeIndex } = entry;
  const { schema, fullName: path } = object;
  const type = getType(object);
  const indices = isAnimated(schema)
    ? selectSamples(schema.timeSampling, schema.numSamples, range)
    : [0];
  const normals =
    type === 'mesh' && schema.numSamples > 0
      ? decideNormals(indices.map((index) => countNormalErrors(schema.getSample(index), path)))
      : null;
  const firstSample = schema.numSamples > 0 ? schema.getSample(indices[0]) : null;
  const layout = createLayout(getLayoutFormats(type, options, firstSample, normals));
  const deltaPositions = type === 'points' && options.bits === 16;
  const encodeSample = (index) => {
    const {
      vertexCount,
      values,
      index: indexBuffer,
    } = readSampleValues(type, schema, path, index, null, normals);
    const ordered = deltaPositions ? sortPoints(values, vertexCount) : values;

    return encodeGeometry(layout, vertexCount, ordered, indexBuffer, deltaPositions);
  };
  const shared = {
    ...(normals && normals !== 'stored' ? { normals } : {}),
    ...(deltaPositions ? { positions: 'delta' } : {}),
  };

  if (indices.length === 1) {
    const track = { mode: 'static', numSamples: 1, ...shared, layout, base: null };
    let geometry = null;

    chunks.push({
      bytes: () => {
        geometry = encodeSample(indices[0]);

        return geometry.bytes;
      },
      assign: (reference) => (track.base = { ...reference, ...geometry.reference }),
    });

    return track;
  }

  const headerTimeSampling = toHeaderTimeSampling(schema.timeSampling, indices);
  const timeSampling = timeSamplings.add(headerTimeSampling);
  const samples = new Array(indices.length);
  const addEvent = (sample, encode) =>
    events.push({
      time: getTime(headerTimeSampling, sample),
      node: nodeIndex,
      sample,
      bytes: () => {
        const { reference, bytes } = encode(indices[sample]);

        return { bytes, assign: (chunk) => (samples[sample] = { ...chunk, ...reference }) };
      },
    });
  // NOTE Points with one width: a set of positions on a grid of width / pointPrecision (FORMAT.md 6.6)
  const pointWidth =
    type === 'points' && options.pointPrecision > 0 ? getConstantWidth(schema, indices) : null;

  if (pointWidth !== null) {
    const step = Math.fround(pointWidth / options.pointPrecision);

    indices.forEach((index, sample) =>
      addEvent(sample, (sourceIndex) => {
        const { origin, count, bytes } = encodePoints(
          schema.getSample(sourceIndex).positions,
          step
        );

        return { bytes, reference: { vertexCount: count, origin } };
      })
    );

    return {
      mode: 'set',
      numSamples: indices.length,
      timeSampling,
      width: pointWidth,
      step,
      samples,
    };
  }

  // NOTE The surface mode has no uv (FORMAT.md 8.4)
  const surface =
    type === 'mesh' && normals !== 'stored' && !firstSample?.uvs && options.surfaceBits > 0
      ? createSurfaceTrack(schema, indices, options.surfaceBits)
      : null;

  if (surface) {
    surface.chunks.forEach(({ bytes, vertexCount, triangleCount }, sample) =>
      addEvent(sample, () => ({ bytes, reference: { vertexCount, triangleCount } }))
    );

    return {
      mode: 'surface',
      numSamples: indices.length,
      timeSampling,
      normals,
      grid: surface.grid,
      volume: surface.volume,
      tBits: options.surfaceBits,
      table: surface.table,
      samples,
    };
  }

  const vertexData = canUseVertexMode(type, schema)
    ? createVertexTrackData(type, schema, path, indices, normals)
    : null;

  if (!vertexData) {
    indices.forEach((index, sample) => addEvent(sample, encodeSample));

    return { mode: 'swap', numSamples: indices.length, timeSampling, ...shared, layout, samples };
  }

  const { first, basePositions, layout: meshLayout } = vertexData;
  const { vertexCount } = first;
  // NOTE Normals in the layers only if they are stored and change (FORMAT.md 6.3). The loader calculates the others.
  const texelStride = normals === 'stored' && !schema.normals.isConstant ? 2 : 1;
  const numTexels = Math.max(vertexCount * texelStride, 1);
  const width = Math.min(numTexels, maxLayerWidth);
  const animation = {
    format: options.bits === 16 ? 'n16x4' : 'f32x4',
    texelStride,
    width,
    height: Math.ceil(numTexels / width),
  };
  const base = encodeGeometry(
    layout,
    vertexCount,
    { ...first.values, position: basePositions },
    first.index
  );
  const decodedBase = decodePositions(layout, base.reference, base.bytes);
  const track = {
    mode: 'vertex',
    numSamples: indices.length,
    timeSampling,
    ...(normals && normals !== 'stored' ? { normals } : {}),
    layout,
    base: null,
    animation,
    samples,
  };

  chunks.push({
    bytes: () => base.bytes,
    assign: (reference) => (track.base = { ...reference, ...base.reference }),
  });
  indices.forEach((index, sample) =>
    addEvent(sample, (sourceIndex) => {
      const { values } = readSampleValues(type, schema, path, sourceIndex, meshLayout, normals);

      return encodeLayer(animation, decodedBase, values.position, values.normal, vertexCount);
    })
  );

  return track;
};

// NOTE Geometry track members in the order of FORMAT.md 3.6
const trackMembers = [
  'mode',
  'numSamples',
  'timeSampling',
  'normals',
  'positions',
  'layout',
  'base',
  'animation',
  'grid',
  'volume',
  'tBits',
  'table',
  'width',
  'step',
  'samples',
];
const orderTrack = (track) =>
  Object.fromEntries(
    trackMembers
      .filter((member) => track[member] !== undefined && track[member] !== null)
      .map((member) => [member, track[member]])
  );

// NOTE Converts one .abc file into one .wabc file (FORMAT.md). Output files are written to a temporary name, then renamed.
export const convertFile = async (inputPath, outputPath, options) => {
  const startTime = Date.now();
  const source = readFileInParts(inputPath);
  const sha256 = getSha256(source);
  const { archive } = await new AlembicReader().read(source);
  const entries = collectEntries(archive.root, options.objects);
  const range = getTimeRange(entries, options.samples);
  const timeSamplings = createTimeSamplingTable();
  const matrixChunks = [];
  const geometryChunks = [];
  const events = [];
  const nodes = entries.map((entry) => {
    const { object, parent } = entry;
    const type = getType(object);
    const node = {
      name: object.name,
      path: object.fullName,
      parent: parent ? parent.index : -1,
      type,
    };
    const matrix = createMatrixTrack(entry, options, range, timeSamplings, matrixChunks);

    if (matrix) {
      node.matrix = matrix;
    }

    if (type !== 'group') {
      node.geometry = createGeometryTrack(
        entry,
        options,
        range,
        timeSamplings,
        geometryChunks,
        events
      );
    }

    return node;
  });

  // NOTE Sample chunks in time order, then node order (FORMAT.md section 7)
  events.sort((a, b) => a.time - b.time || a.node - b.node || a.sample - b.sample);
  mkdirSync(dirname(outputPath), { recursive: true });

  const dataPath = `${outputPath}.data.part`;
  const partPath = `${outputPath}.part`;
  const chunkWriter = new ChunkWriter(dataPath, options.compression);

  try {
    for (const chunk of [...matrixChunks, ...geometryChunks]) {
      chunk.assign(chunkWriter.write(chunk.bytes()));
    }

    for (const event of events) {
      const { bytes, assign } = event.bytes();

      assign(chunkWriter.write(bytes));
    }

    chunkWriter.close();

    for (const node of nodes) {
      if (node.geometry) {
        node.geometry = orderTrack(node.geometry);
      }
    }

    const header = new TextEncoder().encode(
      JSON.stringify({
        writer,
        compression: options.compression,
        source: { file: basename(inputPath), sha256 },
        space: options.space,
        timeSamplings: timeSamplings.timeSamplings,
        nodes,
      })
    );
    const prefix = new Uint8Array(12);
    const view = new DataView(prefix.buffer);

    prefix.set([0x57, 0x41, 0x42, 0x43]);
    view.setUint32(4, 1, true);
    view.setUint32(8, header.length, true);

    const output = openSync(partPath, 'w');
    const data = openSync(dataPath, 'r');
    const part = new Uint8Array(copyPartSize);

    try {
      writeAll(output, prefix);
      writeAll(output, header);

      for (let count; (count = readSync(data, part, 0, part.length, null)) > 0; ) {
        writeAll(output, part.subarray(0, count));
      }
    } finally {
      closeSync(output);
      closeSync(data);
    }

    renameSync(partPath, outputPath);

    const modes = nodes.reduce((total, { geometry }) => {
      if (geometry) {
        total[geometry.mode] = (total[geometry.mode] ?? 0) + 1;
      }

      return total;
    }, {});

    return {
      inputPath,
      outputPath,
      inputBytes: source.length,
      outputBytes: 12 + header.length + chunkWriter.offset,
      nodes: nodes.length,
      modes,
      milliseconds: Date.now() - startTime,
    };
  } finally {
    chunkWriter.close();
    rmSync(dataPath, { force: true });
    rmSync(partPath, { force: true });
  }
};
