// NOTE Vertex formats, ranges and codes (FORMAT.md section 5), geometry and layer chunks (FORMAT.md 4.3, 4.4)

export const formats = {
  f32: { components: 1, size: 4, type: 'f32' },
  f32x2: { components: 2, size: 8, type: 'f32' },
  f32x3: { components: 3, size: 12, type: 'f32' },
  f32x4: { components: 4, size: 16, type: 'f32' },
  n8x4: { components: 4, size: 4, type: 'n8', max: 127 },
  n16x2: { components: 2, size: 4, type: 'n16', max: 32767 },
  n16x4: { components: 4, size: 8, type: 'n16', max: 32767 },
};

// NOTE Components of each attribute value
export const valueComponents = { position: 3, normal: 3, uv: 2, width: 1 };

// NOTE Normals have a fixed range (FORMAT.md 5.1)
const normalRange = { center: [0, 0, 0], extent: [1, 1, 1] };

const f32 = Math.fround;
const bits32 = new Float32Array(1);
const bitsInt = new Int32Array(bits32.buffer);

// NOTE Next f32 value after a value that is 0 or more
const nextUp = (value) => {
  if (value === 0) {
    return 1.401298464324817e-45;
  }

  bits32[0] = value;
  bitsInt[0] += 1;

  return bits32[0];
};

// NOTE Range of FORMAT.md 5.2: center = f32((min + max) / 2), extent = smallest f32 that holds min and max
export const makeRange = (values, numComponents, name) => {
  const center = [];
  const extent = [];

  for (let component = 0; component < numComponents; component++) {
    let min = Infinity;
    let max = -Infinity;

    for (let index = component; index < values.length; index += numComponents) {
      const value = values[index];

      if (!Number.isFinite(value)) {
        throw new Error(`"${name}" has the value ${value}. Only finite values can be stored.`);
      }

      min = Math.min(min, value);
      max = Math.max(max, value);
    }

    if (min === Infinity) {
      center.push(0);
      extent.push(0);
      continue;
    }

    const middle = f32((min + max) / 2);
    let size = f32(Math.max(max - middle, middle - min));

    while (middle - size > min || middle + size < max) {
      size = nextUp(size);
    }

    center.push(middle);
    extent.push(size);
  }

  return { center, extent };
};

// NOTE round(): halves away from zero (FORMAT.md 0.1)
export const encodeCode = (value, center, extent, max) => {
  if (extent === 0) {
    return 0;
  }

  const scaled = ((value - center) * max) / extent;
  const code = Math.sign(scaled) * Math.round(Math.abs(scaled));

  return Math.min(Math.max(code, -max), max);
};

export const decodeCode = (code, center, extent, max) => center + Math.max(code / max, -1) * extent;

// NOTE Attributes in order, each at a multiple of 4 bytes (FORMAT.md 3.8)
export const createLayout = (attributeFormats) => {
  let offset = 0;
  const attributes = attributeFormats.map(([name, format]) => {
    const attribute = { name, format, offset };

    offset += formats[format].size;

    return attribute;
  });

  return { stride: offset, attributes };
};

export const getIndexSize = (vertexCount) => (vertexCount <= 65536 ? 2 : 4);

// NOTE Geometry chunk: vertices, then indices. "values" has one array per attribute, "components" values per vertex.
// Typed arrays use the byte order of the machine. The CLI accepts only little-endian machines.
// "deltaPositions": n16 position codes are stored as differences from the vertex before, with 16-bit wrap (FORMAT.md 5.4).
export const encodeGeometry = (layout, vertexCount, values, index, deltaPositions = false) => {
  const { stride } = layout;
  const indexCount = index ? index.length : 0;
  const indexSize = getIndexSize(vertexCount);
  const buffer = new ArrayBuffer(vertexCount * stride + indexCount * indexSize);
  const vertexBytes = vertexCount * stride;
  // NOTE The views cover only the vertices. The index buffer can have an odd number of u16 values.
  const views = {
    f32: new Float32Array(buffer, 0, vertexBytes / 4),
    n16: new Int16Array(buffer, 0, vertexBytes / 2),
    n8: new Int8Array(buffer, 0, vertexBytes),
  };
  const quantization = {};

  // NOTE Unused components and bytes stay 0 (FORMAT.md 3.8, 5.1)
  for (const { name, format, offset } of layout.attributes) {
    const { type, max } = formats[format];
    const source = values[name];
    const numComponents = valueComponents[name];
    let range = null;

    if (type !== 'f32') {
      range = name === 'normal' ? normalRange : makeRange(source, numComponents, name);

      if (name !== 'normal') {
        quantization[name] = range;
      }
    }

    const view = views[type];
    const itemSize = type === 'f32' ? 4 : type === 'n16' ? 2 : 1;
    const itemStride = stride / itemSize;
    const itemOffset = offset / itemSize;

    const isDelta = deltaPositions && name === 'position' && type === 'n16';
    const previous = [0, 0, 0];

    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const target = vertex * itemStride + itemOffset;

      for (let component = 0; component < numComponents; component++) {
        const value = source[vertex * numComponents + component];
        const code = range
          ? encodeCode(value, range.center[component], range.extent[component], max)
          : value;

        if (isDelta) {
          // NOTE Int16Array keeps the low 16 bits: the wrap of FORMAT.md 5.4
          view[target + component] = code - previous[component];
          previous[component] = code;
        } else {
          view[target + component] = code;
        }
      }
    }
  }

  if (indexCount) {
    const IndexArray = indexSize === 2 ? Uint16Array : Uint32Array;

    new IndexArray(buffer, vertexBytes, indexCount).set(index);
  }

  const reference = { vertexCount, indexCount };

  if (Object.keys(quantization).length > 0) {
    reference.quantization = quantization;
  }

  return { reference, bytes: new Uint8Array(buffer) };
};

// NOTE Decoded positions of a geometry chunk, in f64 (FORMAT.md 6.2)
export const decodePositions = (layout, reference, bytes) => {
  const { format, offset } = layout.attributes.find(({ name }) => name === 'position');
  const { type, max } = formats[format];
  const { vertexCount } = reference;
  const positions = new Float64Array(vertexCount * 3);
  const itemSize = type === 'f32' ? 4 : 2;
  const view =
    type === 'f32'
      ? new Float32Array(bytes.buffer, bytes.byteOffset, (vertexCount * layout.stride) / 4)
      : new Int16Array(bytes.buffer, bytes.byteOffset, (vertexCount * layout.stride) / 2);
  const range = reference.quantization?.position;

  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const source = (vertex * layout.stride + offset) / itemSize;

    for (let component = 0; component < 3; component++) {
      positions[vertex * 3 + component] = range
        ? decodeCode(
            view[source + component],
            range.center[component],
            range.extent[component],
            max
          )
        : view[source + component];
    }
  }

  return positions;
};

// NOTE Layer chunk: texel "vertex × texelStride" is the position delta, texel "+ 1" the normal (FORMAT.md 6.1)
export const encodeLayer = (animation, basePositions, positions, normals, vertexCount) => {
  const { format, texelStride, width, height } = animation;
  const isQuantized = format === 'n16x4';
  const texels = isQuantized
    ? new Int16Array(width * height * 4)
    : new Float32Array(width * height * 4);
  const deltas = new Float64Array(vertexCount * 3);

  for (let index = 0; index < deltas.length; index++) {
    deltas[index] = positions[index] - basePositions[index];
  }

  const reference = {};
  const delta = isQuantized ? makeRange(deltas, 3, 'position delta') : null;

  if (delta) {
    reference.delta = delta;
  }

  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const texel = vertex * texelStride * 4;

    for (let component = 0; component < 3; component++) {
      const value = deltas[vertex * 3 + component];

      texels[texel + component] = isQuantized
        ? encodeCode(value, delta.center[component], delta.extent[component], 32767)
        : value;

      if (texelStride === 2) {
        const normal = normals[vertex * 3 + component];

        texels[texel + 4 + component] = isQuantized ? encodeCode(normal, 0, 1, 32767) : normal;
      }
    }
  }

  return { reference, bytes: new Uint8Array(texels.buffer) };
};
