import * as Three from 'three';

// NOTE Points sample to BufferGeometry. Positions are copied, because sample arrays are shared with the reader cache.
export const createPointsGeometry = (sample) => {
  const geometry = new Three.BufferGeometry();

  if (sample) {
    geometry.setAttribute('position', new Three.BufferAttribute(sample.positions.slice(), 3));
  }

  return geometry;
};
