// NOTE Density grids of .wabc tracks for the liquid views: a cube of resolution^3 bytes, x first, in a world box

// NOTE Box that is a cube around min and max, with the same center
const toCube = (min, max) => {
  const side = Math.max(...[0, 1, 2].map((axis) => max[axis] - min[axis]), 1e-6);
  const center = [0, 1, 2].map((axis) => (min[axis] + max[axis]) / 2.0);

  return {
    min: center.map((value) => value - side / 2.0),
    max: center.map((value) => value + side / 2.0),
  };
};

// NOTE Surface track: grid nodes centered in a cube of the longest grid side
export const getSurfaceLayout = ({ grid, volume }, maxResolution) => {
  const side = Math.max(...volume.size);
  const resolution = Math.min(side, maxResolution);
  const pad = volume.size.map((size) => Math.floor((side - size) / 2));
  const min = [0, 1, 2].map(
    (axis) => grid.origin[axis] + (volume.first[axis] - pad[axis] - 0.5) * grid.spacing[axis]
  );
  const max = min.map((value, axis) => value + side * grid.spacing[axis]);
  // NOTE Texel of each node on each axis
  const texels = volume.size.map((size, axis) =>
    Int32Array.from({ length: size }, (_, node) =>
      Math.floor(((node + pad[axis]) * resolution) / side)
    )
  );

  return { resolution, size: volume.size, texels, bbox: { min, max } };
};

// NOTE Sign 1 is inside. Density 255: a node of the texel is inside. A mean of the nodes removes liquid thinner
// NOTE than half a texel. Blocks with state 0 are all outside and are not read.
export const surfaceToDensity = (
  { signs, blockStates },
  blockSize,
  { resolution, size, texels }
) => {
  const [nx, ny, nz] = size;
  const [tx, ty, tz] = texels;
  const plane = resolution * resolution;
  const density = new Uint8Array(plane * resolution);
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
              if (signs[source + x]) {
                density[row + tx[x]] = 255;
              }
            }
          }
        }
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
  const last = resolution - 1;
  let source = density;
  let target = new Uint8Array(density.length);

  // NOTE The rows before and after a row on the y or z axis. At the grid side, the row itself.
  const smoothRows = (stride) => {
    for (let z = 0; z < resolution; z++) {
      for (let y = 0; y < resolution; y++) {
        const row = (y + z * resolution) * resolution;
        const coordinate = stride === resolution ? y : z;
        const before = coordinate > 0 ? row - stride : row;
        const after = coordinate < last ? row + stride : row;

        for (let x = 0; x < resolution; x++) {
          target[row + x] = (source[before + x] + 2 * source[row + x] + source[after + x] + 2) >> 2;
        }
      }
    }
  };

  const smoothColumns = () => {
    for (let row = 0; row < source.length; row += resolution) {
      const end = row + last;

      target[row] = (3 * source[row] + source[row + Math.min(1, last)] + 2) >> 2;

      for (let index = row + 1; index < end; index++) {
        target[index] = (source[index - 1] + 2 * source[index] + source[index + 1] + 2) >> 2;
      }

      if (last > 0) {
        target[end] = (source[end - 1] + 3 * source[end] + 2) >> 2;
      }
    }
  };

  for (let pass = 0; pass < passes; pass++) {
    smoothColumns();
    [source, target] = [target, source];
    smoothRows(resolution);
    [source, target] = [target, source];
    smoothRows(plane);
    [source, target] = [target, source];
  }

  return source;
};

// NOTE Texels on each side of a cell of the coarse grid
export const coarseBlockSize = 8;

// NOTE Coarse grid: the largest density of each cell and of the cells next to it. A ray march skips cells with 0.
export const getCoarseGrid = (density, resolution) => {
  const size = Math.ceil(resolution / coarseBlockSize);
  const plane = resolution * resolution;
  const cellMax = new Uint8Array(size ** 3);

  for (let z = 0; z < resolution; z++) {
    const cz = Math.floor(z / coarseBlockSize) * size * size;

    for (let y = 0; y < resolution; y++) {
      const cy = cz + Math.floor(y / coarseBlockSize) * size;
      const row = y * resolution + z * plane;

      for (let x = 0; x < resolution; x++) {
        const value = density[row + x];
        const cell = cy + Math.floor(x / coarseBlockSize);

        if (value > cellMax[cell]) {
          cellMax[cell] = value;
        }
      }
    }
  }

  const coarse = new Uint8Array(cellMax.length);
  const last = size - 1;

  for (let z = 0, cell = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++, cell++) {
        let value = 0;

        for (let nz = Math.max(z - 1, 0); nz <= Math.min(z + 1, last); nz++) {
          for (let ny = Math.max(y - 1, 0); ny <= Math.min(y + 1, last); ny++) {
            for (let nx = Math.max(x - 1, 0); nx <= Math.min(x + 1, last); nx++) {
              value = Math.max(value, cellMax[nx + (ny + nz * size) * size]);
            }
          }
        }

        coarse[cell] = value;
      }
    }
  }

  return coarse;
};
