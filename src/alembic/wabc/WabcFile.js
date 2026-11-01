import { AlembicError } from '../core/AlembicError.js';
import { decodePoints } from './points.js';
import { buildSurfaceMesh, decodeSurfaceSample } from './surfaceCodec.js';

// NOTE Reader of .wabc files (src/wabc/FORMAT.md). Chunks are read when a sample is read. All values are typed arrays.

const formats = {
  f32: { components: 1, size: 4, type: 'f32' },
  f32x2: { components: 2, size: 8, type: 'f32' },
  f32x3: { components: 3, size: 12, type: 'f32' },
  n8x4: { components: 4, size: 4, type: 'n8', max: 127 },
  n16x2: { components: 2, size: 4, type: 'n16', max: 32767 },
  n16x4: { components: 4, size: 8, type: 'n16', max: 32767 },
};
const valueComponents = { position: 3, normal: 3, uv: 2, width: 1 };
const normalRange = { center: [0, 0, 0], extent: [1, 1, 1] };
const modes = ['static', 'vertex', 'swap', 'surface', 'set'];

const fail = (message) => {
  throw new AlembicError(message);
};

const decodeCode = (code, center, extent, max) => center + Math.max(code / max, -1) * extent;

// NOTE DecompressionStream is in browsers and in Node.js 18 and later
const decompress = async (bytes, compression) => {
  let stream;

  try {
    stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(compression));
  } catch (error) {
    throw new AlembicError(
      `This platform cannot decompress "${compression}" chunks. ${error.message}`,
      {
        cause: error,
      }
    );
  }

  return new Uint8Array(await new Response(stream).arrayBuffer());
};

// NOTE Values of one geometry chunk (FORMAT.md 4.3, 5.3, 5.4). Positions, normals, uvs and widths are Float32Arrays.
const decodeGeometry = (layout, reference, bytes, deltaPositions) => {
  const { vertexCount, indexCount } = reference;
  const { stride } = layout;
  const indexSize = vertexCount <= 65536 ? 2 : 4;

  if (bytes.length !== vertexCount * stride + indexCount * indexSize) {
    fail(
      `A geometry chunk has ${bytes.length} bytes. Its reference gives ${
        vertexCount * stride + indexCount * indexSize
      }.`
    );
  }

  // NOTE The chunk is copied, so that the typed arrays start at byte 0
  const buffer = bytes.slice().buffer;
  const vertexBytes = vertexCount * stride;
  const views = {
    f32: new Float32Array(buffer, 0, vertexBytes / 4),
    n16: new Int16Array(buffer, 0, vertexBytes / 2),
    n8: new Int8Array(buffer, 0, vertexBytes),
  };
  const values = {};

  for (const { name, format, offset } of layout.attributes) {
    const info = formats[format] ?? fail(`The attribute "${name}" has the format "${format}".`);
    const components = valueComponents[name] ?? info.components;
    const itemSize = info.type === 'f32' ? 4 : info.type === 'n16' ? 2 : 1;
    const view = views[info.type];
    const range =
      info.type === 'f32' ? null : name === 'normal' ? normalRange : reference.quantization?.[name];

    if (info.type !== 'f32' && !range) {
      fail(`The attribute "${name}" has no range.`);
    }

    const out = new Float32Array(vertexCount * components);
    const sums = [0, 0, 0];
    const isDelta = deltaPositions && name === 'position' && info.type === 'n16';

    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const source = (vertex * stride + offset) / itemSize;

      for (let component = 0; component < components; component++) {
        let code = view[source + component];

        if (isDelta) {
          sums[component] = ((sums[component] + code) << 16) >> 16;
          code = sums[component];
        }

        out[vertex * components + component] = range
          ? decodeCode(code, range.center[component], range.extent[component], info.max)
          : code;
      }
    }

    values[name] = out;
  }

  let index = null;

  if (indexCount > 0) {
    index =
      indexSize === 2
        ? new Uint16Array(buffer, vertexBytes, indexCount)
        : new Uint32Array(buffer, vertexBytes, indexCount);

    for (const vertex of index) {
      if (vertex >= vertexCount) {
        fail(`An index is ${vertex}. The geometry has ${vertexCount} vertices.`);
      }
    }
  }

  return { vertexCount, ...values, index };
};

// NOTE Geometry of one sample: { vertexCount, position, normal, uv, width, index, normals }.
// "normals": "flat" or "smooth" if the loader makes the normals (computeFlatNormals, computeSmoothNormals), else "stored".
// Meshes have clockwise triangles (a, b, c), as in the source. "index" is null for points and meshes without an index.
class GeometryTrack {
  constructor(file, node) {
    this.file = file;
    this.node = node;
    this.track = node.geometry;
    this.normals = node.type === 'mesh' ? this.track.normals ?? 'stored' : null;
    this.surfaceState = null;
    this.base = null;
  }

  get mode() {
    return this.track.mode;
  }

  get numSamples() {
    return this.track.numSamples;
  }

  // NOTE Time of a sample in seconds. A static track has the time 0.
  getSampleTime(sample) {
    return this.track.timeSampling === undefined
      ? 0
      : this.file.getTime(this.track.timeSampling, sample);
  }

  async readBase() {
    if (!this.base) {
      const { layout, base, positions } = this.track;

      this.base = decodeGeometry(
        layout,
        base,
        await this.file.readChunk(base),
        positions === 'delta'
      );
    }

    return this.base;
  }

  async readSample(sample) {
    const { mode, layout, samples, animation, positions } = this.track;

    if (!Number.isInteger(sample) || sample < 0 || sample >= this.track.numSamples) {
      throw new RangeError(
        `Sample ${sample} does not exist. The track has ${this.track.numSamples} samples.`
      );
    }

    if (mode === 'static') {
      return { ...(await this.readBase()), normals: this.normals };
    }

    if (mode === 'swap') {
      const reference = samples[sample];

      return {
        ...decodeGeometry(
          layout,
          reference,
          await this.file.readChunk(reference),
          positions === 'delta'
        ),
        normals: this.normals,
      };
    }

    if (mode === 'vertex') {
      return { ...(await this.readLayer(sample)), normals: this.normals };
    }

    if (mode === 'surface') {
      return this.readSurface(sample);
    }

    if (mode === 'set') {
      const reference = samples[sample];
      const position = decodePoints(
        await this.file.readChunk(reference),
        reference.vertexCount,
        reference.origin,
        this.track.step
      );

      return {
        vertexCount: reference.vertexCount,
        position,
        width: this.track.width,
        index: null,
        normals: null,
      };
    }

    return fail(`The geometry mode "${mode}" is not known.`);
  }

  // NOTE Layer of a "vertex" track: base position plus the delta, and the normal of the layer if it has one (FORMAT.md 6.2, 6.3)
  async readLayer(sample) {
    const base = await this.readBase();
    const reference = this.track.samples[sample];
    const { format, texelStride, width, height } = this.track.animation;
    const bytes = await this.file.readChunk(reference);
    const texelSize = format === 'n16x4' ? 8 : 16;

    if (bytes.length !== width * height * texelSize) {
      fail(
        `A layer chunk has ${bytes.length} bytes. Its track gives ${width * height * texelSize}.`
      );
    }

    const buffer = bytes.slice().buffer;
    const texels = format === 'n16x4' ? new Int16Array(buffer) : new Float32Array(buffer);
    const position = new Float32Array(base.vertexCount * 3);
    const normal = texelStride === 2 ? new Float32Array(base.vertexCount * 3) : base.normal;
    const delta = reference.delta;

    for (let vertex = 0; vertex < base.vertexCount; vertex++) {
      const texel = vertex * texelStride * 4;

      for (let k = 0; k < 3; k++) {
        const value = delta
          ? decodeCode(texels[texel + k], delta.center[k], delta.extent[k], 32767)
          : texels[texel + k];

        position[vertex * 3 + k] = base.position[vertex * 3 + k] + value;

        if (texelStride === 2) {
          normal[vertex * 3 + k] = delta
            ? Math.max(texels[texel + 4 + k] / 32767, -1)
            : texels[texel + 4 + k];
        }
      }
    }

    return { ...base, position, normal };
  }

  // NOTE Mesh of a surface sample, from its signs (decodeSurface) and the table of the track
  async readSurface(sample) {
    const { positions, index } = buildSurfaceMesh(await this.decodeSurface(sample), this.track);

    return { vertexCount: positions.length / 3, position: positions, index, normals: this.normals };
  }

  // NOTE Signs, crossed edges and edge codes of a surface sample. A sample needs the signs of the sample before it,
  // so samples are decoded in order (FORMAT.md 7). The result of every "checkpointInterval"-th sample is kept, so a
  // sample before the last one starts from there. The result is used again: do not change its arrays.
  async decodeSurface(sample) {
    const { samples, tBits, volume } = this.track;
    const interval = this.file.checkpointInterval;

    this.checkpoints ??= new Map();

    if (!this.surfaceState || this.surfaceState.sample > sample) {
      const start = Math.floor(sample / interval) * interval;
      const checkpoint = [...this.checkpoints.keys()]
        .filter((key) => key <= start)
        .sort((a, b) => b - a)[0];

      this.surfaceState =
        checkpoint === undefined
          ? { sample: -1, decoded: null }
          : { sample: checkpoint, decoded: this.checkpoints.get(checkpoint) };
    }

    while (this.surfaceState.sample < sample) {
      const next = this.surfaceState.sample + 1;
      const reference = samples[next];
      const decoded = decodeSurfaceSample(
        await this.file.readChunk(reference),
        this.surfaceState.decoded,
        volume.size,
        tBits
      );

      if (decoded.edges.length !== reference.vertexCount) {
        fail(
          `Surface sample ${next} has ${decoded.edges.length} crossed edges. Its reference gives ${reference.vertexCount}.`
        );
      }

      if (next % interval === 0) {
        this.checkpoints.set(next, decoded);
      }

      this.surfaceState = { sample: next, decoded };
    }

    return this.surfaceState.decoded;
  }
}

// NOTE A .wabc file in memory. "nodes": the nodes of the header. Matrices and geometries are read with the methods.
export class WabcFile {
  // NOTE Surface tracks keep the signs of each sample with an index that is a multiple of this
  checkpointInterval = 25;

  constructor(bytes) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('WabcFile source must be a Uint8Array.');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'WABC') {
      fail('File is not a .wabc file.');
    }

    const version = view.getUint32(4, true);
    const headerLength = view.getUint32(8, true);

    if (version !== 1) {
      fail(`The .wabc version is ${version}. Only version 1 can be read.`);
    }

    if (headerLength > bytes.length - 12) {
      fail('The .wabc header is longer than the file.');
    }

    this.bytes = bytes;
    this.header = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(12, 12 + headerLength))
    );
    this.dataStart = 12 + headerLength;
    this.validate();
  }

  validate() {
    const { header } = this;
    const dataLength = this.bytes.length - this.dataStart;
    const checkChunk = (reference) => {
      if (
        !(
          reference.offset >= 0 &&
          reference.length >= 0 &&
          reference.offset + reference.length <= dataLength
        )
      ) {
        fail('A chunk is outside the data section.');
      }
    };

    for (const name of header.extensionsRequired ?? []) {
      fail(`The file needs the extension "${name}".`);
    }

    if (!['deflate', 'brotli'].includes(header.compression)) {
      fail(`The compression "${header.compression}" is not known.`);
    }

    header.nodes.forEach((node, index) => {
      if (!(node.parent >= -1 && node.parent < index)) {
        fail(`Node "${node.path}" has the parent ${node.parent}.`);
      }

      if (node.matrix?.chunk) {
        checkChunk(node.matrix.chunk);
      }

      const geometry = node.geometry;

      if (!geometry) {
        return;
      }

      if (!modes.includes(geometry.mode)) {
        fail(`Node "${node.path}" has the geometry mode "${geometry.mode}".`);
      }

      if (geometry.timeSampling !== undefined && !header.timeSamplings[geometry.timeSampling]) {
        fail(`Node "${node.path}" has the time sampling ${geometry.timeSampling}.`);
      }

      if (geometry.base) {
        checkChunk(geometry.base);
      }

      (geometry.samples ?? []).forEach(checkChunk);
    });
  }

  get nodes() {
    return this.header.nodes;
  }

  get space() {
    return this.header.space;
  }

  getTime(timeSampling, sample) {
    const { type, start, step, times } = this.header.timeSamplings[timeSampling];

    return type === 'uniform' ? start + sample * step : times[sample];
  }

  async readChunk({ offset, length }) {
    const start = this.dataStart + offset;

    return decompress(this.bytes.subarray(start, start + length), this.header.compression);
  }

  // NOTE Matrices of a node: one Float32Array of 16 values for each sample, in the order of an Xform matrix op
  // (value 4j + k is Imath m[j][k], row vectors). A node without a matrix track has one identity matrix.
  async readMatrices(nodeIndex) {
    const { matrix } = this.header.nodes[nodeIndex];

    if (!matrix) {
      return [Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)];
    }

    if (matrix.numSamples === 1) {
      return [Float32Array.from(matrix.values)];
    }

    const bytes = await this.readChunk(matrix.chunk);

    if (bytes.length !== matrix.numSamples * 64) {
      fail(`A matrix chunk has ${bytes.length} bytes. Its track gives ${matrix.numSamples * 64}.`);
    }

    const values = new Float32Array(bytes.slice().buffer);

    return Array.from({ length: matrix.numSamples }, (_, sample) =>
      values.subarray(sample * 16, sample * 16 + 16)
    );
  }

  // NOTE Time of matrix sample "sample" of a node, in seconds
  getMatrixTime(nodeIndex, sample) {
    const { matrix } = this.header.nodes[nodeIndex];

    return matrix?.timeSampling === undefined ? 0 : this.getTime(matrix.timeSampling, sample);
  }

  // NOTE Geometry track of a mesh or points node, or null. Its "readSample" gives the geometry of a sample.
  getGeometry(nodeIndex) {
    const node = this.header.nodes[nodeIndex];

    return node.geometry ? new GeometryTrack(this, node) : null;
  }
}
