// NOTE Density grids of .wabc tracks: a cube of resolution^3 bytes, x first, in a world box.
// Raw data for FrameVolume.

// NOTE Box that is a cube around min and max, with the same center
const toCube = (min, max) => {
  const side = Math.max(...[0, 1, 2].map((axis) => max[axis] - min[axis]), 1e-6);
  const center = [0, 1, 2].map((axis) => (min[axis] + max[axis]) / 2.0);

  return {
    min: center.map((value) => value - side / 2.0),
    max: center.map((value) => value + side / 2.0),
  };
};

// NOTE Surface track: grid nodes centered in a cube of the longest grid side.
// At a lower resolution, a texel is the mean of its nodes.
export const getSurfaceLayout = ({ grid, volume }, maxResolution) => {
  const side = Math.max(...volume.size);
  const resolution = Math.min(side, maxResolution);
  const pad = volume.size.map((size) => Math.floor((side - size) / 2));
  const min = [0, 1, 2].map(
    (axis) => grid.origin[axis] + (volume.first[axis] - pad[axis] - 0.5) * grid.spacing[axis]
  );
  const max = min.map((value, axis) => value + side * grid.spacing[axis]);
  // NOTE Texel of each node on each axis, and the count of cube nodes in each texel on each axis
  const texels = volume.size.map((size, axis) =>
    Int32Array.from({ length: size }, (_, node) =>
      Math.floor(((node + pad[axis]) * resolution) / side)
    )
  );
  const binSize = new Float32Array(resolution);

  for (let node = 0; node < side; node++) {
    binSize[Math.floor((node * resolution) / side)]++;
  }

  return { resolution, size: volume.size, texels, binSize, bbox: { min, max } };
};

// NOTE Sign 1 is inside. Density 255: all nodes of the texel are inside.
// Blocks with state 0 are all outside and are not read.
export const surfaceToDensity = (
  { signs, blockStates },
  blockSize,
  { resolution, size, texels, binSize }
) => {
  const [nx, ny, nz] = size;
  const [tx, ty, tz] = texels;
  const plane = resolution * resolution;
  const inside = new Float32Array(plane * resolution);
  let block = 0;

  for (let bz = 0; bz < nz; bz += blockSize) {
    for (let by = 0; by < ny; by += blockSize) {
      for (let bx = 0; bx < nx; bx += blockSize, block++) {
        if (blockStates[block] === 0) {
          continue;
        }

        const ex = Math.min(bx + blockSize, nx);
        const ey = Math.min(by + blockSize, ny);
        const ez = Math.min(bz + blockSize, nz);

        for (let z = bz; z < ez; z++) {
          for (let y = by; y < ey; y++) {
            const source = (y + z * ny) * nx;
            const row = ty[y] * resolution + tz[z] * plane;

            for (let x = bx; x < ex; x++) {
              inside[row + tx[x]] += signs[source + x];
            }
          }
        }
      }
    }
  }

  const density = new Uint8Array(inside.length);

  for (let z = 0, index = 0; z < resolution; z++) {
    for (let y = 0; y < resolution; y++) {
      const rowSize = binSize[y] * binSize[z];

      for (let x = 0; x < resolution; x++, index++) {
        density[index] = Math.round((inside[index] / (rowSize * binSize[x])) * 255.0);
      }
    }
  }

  return density;
};

// NOTE Points track: a cube around the points of some samples, plus one point width.
// Points out of the box are not used.
export const getPointsBox = (samples, width) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  samples.forEach((position) => {
    for (let index = 0; index < position.length; index += 3) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], position[index + axis]);
        max[axis] = Math.max(max[axis], position[index + axis]);
      }
    }
  });

  if (min[0] > max[0]) {
    return toCube([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
  }

  return toCube(
    min.map((value) => value - width),
    max.map((value) => value + width)
  );
};

// NOTE Each point adds its volume (a cube of its width) to the 8 nearest texels, trilinear.
// Density 255: the texel is full.
export const pointsToDensity = (position, width, { min, max }, resolution) => {
  const plane = resolution * resolution;
  const fill = new Float32Array(plane * resolution);
  const cell = (max[0] - min[0]) / resolution;
  const pointFill = Math.min((width / cell) ** 3, 1.0);
  const last = resolution - 1;

  for (let index = 0; index < position.length; index += 3) {
    const gx = (position[index] - min[0]) / cell - 0.5;
    const gy = (position[index + 1] - min[1]) / cell - 0.5;
    const gz = (position[index + 2] - min[2]) / cell - 0.5;
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const z0 = Math.floor(gz);

    if (x0 < -1 || y0 < -1 || z0 < -1 || x0 > last || y0 > last || z0 > last) {
      continue;
    }

    const fx = gx - x0;
    const fy = gy - y0;
    const fz = gz - z0;

    for (let corner = 0; corner < 8; corner++) {
      const dx = corner & 1;
      const dy = (corner >> 1) & 1;
      const dz = corner >> 2;
      const x = x0 + dx;
      const y = y0 + dy;
      const z = z0 + dz;

      if (x < 0 || y < 0 || z < 0 || x > last || y > last || z > last) {
        continue;
      }

      const weight = (dx ? fx : 1.0 - fx) * (dy ? fy : 1.0 - fy) * (dz ? fz : 1.0 - fz);

      fill[x + y * resolution + z * plane] += weight * pointFill;
    }
  }

  const density = new Uint8Array(fill.length);

  for (let index = 0; index < fill.length; index++) {
    density[index] = Math.min(Math.round(fill[index] * 255.0), 255);
  }

  return density;
};

// NOTE Filter (1, 2, 1) / 4 on each axis, "passes" times. Softens the steps between texels.
export const smoothDensity = (density, resolution, passes) => {
  if (passes <= 0) {
    return density;
  }

  const plane = resolution * resolution;
  const strides = [1, resolution, plane];
  const last = resolution - 1;
  let source = density;
  let target = new Uint8Array(density.length);

  for (let pass = 0; pass < passes; pass++) {
    for (let axis = 0; axis < 3; axis++) {
      const stride = strides[axis];

      for (let z = 0, index = 0; z < resolution; z++) {
        for (let y = 0; y < resolution; y++) {
          for (let x = 0; x < resolution; x++, index++) {
            const coordinate = axis === 0 ? x : axis === 1 ? y : z;
            const value = source[index];
            const before = coordinate > 0 ? source[index - stride] : value;
            const after = coordinate < last ? source[index + stride] : value;

            target[index] = (before + 2 * value + after + 2) >> 2;
          }
        }
      }

      [source, target] = [target, source];
    }
  }

  return source;
};
