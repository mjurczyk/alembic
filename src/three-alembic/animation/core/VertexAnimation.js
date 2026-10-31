import * as Three from 'three';
import { getParameterSources, getPointSources } from '../../geometry/PolyMeshGeometry.js';

// NOTE Texture size limits (WebGPU defaults: 8192 texels for each side, 256 layers)
const textureWidth = 4096;
const maxTextureHeight = 8192;
const maxLayers = 256;
// NOTE Samples loaded before they are needed
const lookaheadSamples = 4;
// NOTE Items between two yields (see runProgressive)
const partSize = 4096;

// NOTE Vertex animation of each node. The shader nodes of the backend read it.
const animations = new WeakMap();

export const getVertexAnimation = (node) => animations.get(node) ?? null;

// NOTE True if all samples have the same vertices. Faces, uv and normal indices do not change. Points: ids do not change.
export const canUseVertexAnimation = (schema) => {
  if (schema.type === 'Points') {
    return schema.idsProperty.isConstant;
  }

  if (schema.type !== 'PolyMesh') {
    return false;
  }

  const { faceIndicesProperty, faceCountsProperty, normals, uvs } = schema;

  return (
    faceIndicesProperty.isConstant &&
    faceCountsProperty.isConstant &&
    (!uvs || uvs.isConstant) &&
    (!normals?.indicesProperty || normals.indicesProperty.isConstant)
  );
};

// NOTE Writes a vec3 of each vertex into texel "vertex * stride + component" of the layer
function* writeTexels(data, offset, stride, component, values, sources, numVertices) {
  for (let start = 0; start < numVertices; start += partSize) {
    const end = Math.min(start + partSize, numVertices);

    for (let vertex = start; vertex < end; vertex++) {
      const source = (sources ? sources[vertex] : vertex) * 3;
      const texel = offset + (vertex * stride + component) * 4;

      data[texel] = values[source];
      data[texel + 1] = values[source + 1];
      data[texel + 2] = values[source + 2];
      data[texel + 3] = 1.0;
    }

    yield;
  }
}

// NOTE Vertex normals from the positions in the layer, as BufferGeometry.computeVertexNormals
function* computeNormals(data, offset, index, numVertices) {
  const getPosition = (vertex) => offset + vertex * 8;
  const getNormal = (vertex) => offset + vertex * 8 + 4;

  for (let vertex = 0; vertex < numVertices; vertex++) {
    data.fill(0.0, getNormal(vertex), getNormal(vertex) + 3);
  }

  yield;

  for (let start = 0; start < index.length; start += partSize * 3) {
    const end = Math.min(start + partSize * 3, index.length);

    for (let item = start; item < end; item += 3) {
      const a = getPosition(index[item]);
      const b = getPosition(index[item + 1]);
      const c = getPosition(index[item + 2]);
      // NOTE (c - b) x (a - b)
      const cbX = data[c] - data[b];
      const cbY = data[c + 1] - data[b + 1];
      const cbZ = data[c + 2] - data[b + 2];
      const abX = data[a] - data[b];
      const abY = data[a + 1] - data[b + 1];
      const abZ = data[a + 2] - data[b + 2];
      const x = cbY * abZ - cbZ * abY;
      const y = cbZ * abX - cbX * abZ;
      const z = cbX * abY - cbY * abX;

      for (let corner = 0; corner < 3; corner++) {
        const normal = getNormal(index[item + corner]);

        data[normal] += x;
        data[normal + 1] += y;
        data[normal + 2] += z;
      }
    }

    yield;
  }

  for (let vertex = 0; vertex < numVertices; vertex++) {
    const normal = getNormal(vertex);
    const length = Math.hypot(data[normal], data[normal + 1], data[normal + 2]);

    if (length > 0.0) {
      data[normal] /= length;
      data[normal + 1] /= length;
      data[normal + 2] /= length;
    }
  }
}

// NOTE Samples with the same vertices in a float texture array, one sample in each layer. The vertex shader blends two layers.
export class VertexAnimation {
  floorIndex = 0;
  ceilIndex = 0;
  floorLayer = 0;
  ceilLayer = 0;
  alpha = 0.0;
  // NOTE True when floorLayer and ceilLayer hold the samples on screen
  isShown = false;
  // NOTE True if a sample does not match the first sample (point count). Then the geometry is swapped.
  failed = false;

  constructor(
    node,
    schema,
    {
      numVertices,
      numPoints,
      normalSource,
      pointSources,
      normalSources,
      numNormalValues,
      index,
      width,
      height,
      numLayers,
    }
  ) {
    this.node = node;
    this.schema = schema;
    this.numVertices = numVertices;
    this.numPoints = numPoints;
    this.normalSource = normalSource;
    this.hasNormals = normalSource !== null;
    this.stride = this.hasNormals ? 2 : 1;
    this.pointSources = pointSources;
    this.normalSources = normalSources;
    this.numNormalValues = numNormalValues;
    this.index = index;
    this.width = width;
    this.height = height;
    this.numLayers = numLayers;
    this.layerSamples = new Int32Array(numLayers).fill(-1);
    this.sampleLayers = new Map();

    // NOTE Texel "vertex * stride" is the position. Texel "vertex * stride + 1" is the normal.
    this.texture = new Three.DataArrayTexture(
      new Float32Array(width * height * 4 * numLayers),
      width,
      height,
      numLayers
    );
    this.texture.type = Three.FloatType;

    animations.set(node, this);
  }

  // NOTE Gives null if the texture is too large. "layout" (PolyMesh only) and "geometry" are from the first sample.
  static *create(node, schema, { layout, geometry, textureMemory }) {
    const isMesh = schema.type === 'PolyMesh';
    const numVertices = isMesh ? layout.numVertices : geometry.getAttribute('position').count;
    const normal = isMesh ? layout.parameters.normal : null;
    let normalSource = null;

    // NOTE Animated normals of the file, or normals computed from each sample. Constant normals stay in the geometry.
    if (isMesh && normal && !schema.normals.isConstant) {
      normalSource = 'file';
    } else if (isMesh && !normal && !schema.positionsProperty.isConstant) {
      normalSource = 'computed';
    }

    const numTexels = Math.max(numVertices * (normalSource ? 2 : 1), 1);
    const width = Math.min(numTexels, textureWidth);
    const height = Math.ceil(numTexels / width);
    const numLayers = Math.min(
      schema.numSamples,
      maxLayers,
      Math.floor(textureMemory / (width * height * 16))
    );

    // NOTE Layers are used again only if there are 4 or more: 2 on screen, and the 2 samples to show next
    if (height > maxTextureHeight || numLayers < Math.min(4, schema.numSamples)) {
      return null;
    }

    return new VertexAnimation(node, schema, {
      numVertices,
      numPoints: isMesh ? layout.counts.numPoints : numVertices,
      normalSource,
      pointSources: isMesh ? yield* getPointSources(layout) : null,
      normalSources: normalSource === 'file' ? yield* getParameterSources(layout, normal) : null,
      numNormalValues: normal?.numValues ?? 0,
      index: normalSource === 'computed' ? geometry.index.array : null,
      width,
      height,
      numLayers,
    });
  }

  // NOTE Shows the blend if both samples are loaded. Else the last blend stays on screen.
  setBlend({ floorIndex, ceilIndex, alpha }) {
    const floorLayer = this.sampleLayers.get(floorIndex);
    const ceilLayer = this.sampleLayers.get(ceilIndex);

    this.floorIndex = floorIndex;
    this.ceilIndex = ceilIndex;

    if (floorLayer === undefined || ceilLayer === undefined) {
      return false;
    }

    this.floorLayer = floorLayer;
    this.ceilLayer = ceilLayer;
    this.alpha = alpha;
    this.isShown = true;

    return true;
  }

  // NOTE Floor and ceil samples, then the next samples in the playback direction (1 or -1)
  getWantedSamples(direction, loop) {
    const { numSamples } = this.schema;
    const wanted = [this.floorIndex, this.ceilIndex];
    // NOTE If layers are used again, the lookahead samples, the samples on screen and the floor and ceil samples must fit
    const isResident = this.numLayers === numSamples;
    const numLookahead = isResident
      ? lookaheadSamples
      : Math.min(this.numLayers - 4, lookaheadSamples);
    let index = direction > 0 ? this.ceilIndex : this.floorIndex;

    for (let step = 0; step < numLookahead; step++) {
      index += direction;

      if (index < 0 || index >= numSamples) {
        if (!loop) {
          break;
        }

        index = (index + numSamples) % numSamples;
      }

      wanted.push(index);
    }

    return wanted;
  }

  // NOTE First wanted sample that is not loaded, and has a layer. "required": only the floor and ceil samples.
  getMissingSample(direction, loop, required = false) {
    const wanted = required
      ? [this.floorIndex, this.ceilIndex]
      : this.getWantedSamples(direction, loop);
    const index = wanted.find((index) => !this.sampleLayers.has(index)) ?? null;

    return index !== null && this.getLayer(direction) !== -1 ? index : null;
  }

  // NOTE Free layer, or the layer whose sample is needed last. Layers on screen and the wanted samples stay.
  getLayer(direction) {
    const { numSamples } = this.schema;
    const shownLayers = this.isShown ? [this.floorLayer, this.ceilLayer] : [];
    let bestLayer = -1;
    let bestDistance = -1;

    for (let layer = 0; layer < this.numLayers; layer++) {
      const index = this.layerSamples[layer];

      if (shownLayers.includes(layer)) {
        continue;
      }

      if (index === -1) {
        return layer;
      }

      if (index === this.floorIndex || index === this.ceilIndex) {
        continue;
      }

      const distance =
        ((((index - this.floorIndex) * direction) % numSamples) + numSamples) % numSamples;

      if (distance > bestDistance) {
        bestDistance = distance;
        bestLayer = layer;
      }
    }

    return bestLayer;
  }

  matches(sample) {
    if (sample.positions.length / 3 !== this.numPoints) {
      return false;
    }

    return (
      this.normalSource !== 'file' || sample.normals?.values.length / 3 === this.numNormalValues
    );
  }

  // NOTE Reads the sample (each property at the time of the sample) into a layer. Yields after each part (see runProgressive).
  *loadSample(index, direction = 1) {
    const { schema, texture, width, height, stride, numVertices } = this;

    if (this.sampleLayers.has(index)) {
      return;
    }

    // NOTE A sample read cannot be split. It has a part of its own.
    yield true;

    const sample = schema.getSampleAtTime(schema.timeSampling.getSampleTime(index));

    yield true;

    if (!sample || !this.matches(sample)) {
      this.failed = true;

      return;
    }

    // NOTE Selected after the read, because the samples on screen can change. A layer is not shown while it is written.
    const layer = this.getLayer(direction);

    if (layer === -1 || this.sampleLayers.has(index)) {
      return;
    }

    const data = texture.image.data;
    const offset = layer * width * height * 4;

    this.sampleLayers.delete(this.layerSamples[layer]);
    this.layerSamples[layer] = -1;

    yield* writeTexels(data, offset, stride, 0, sample.positions, this.pointSources, numVertices);

    if (this.normalSource === 'file') {
      const { values } = sample.normals;

      yield* writeTexels(data, offset, stride, 1, values, this.normalSources, numVertices);
    } else if (this.normalSource === 'computed') {
      yield* computeNormals(data, offset, this.index, numVertices);
    }

    this.layerSamples[layer] = index;
    this.sampleLayers.set(index, layer);
    texture.addLayerUpdate(layer);
    texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
    animations.delete(this.node);
  }
}
