import * as Three from 'three';

const composed = new Three.Matrix4();

// NOTE Position, rotation and scale of the matrix. Gives false if they do not give the same matrix (shear).
export const decomposeExact = (matrix, position, quaternion, scale) => {
  matrix.decompose(position, quaternion, scale);
  composed.compose(position, quaternion, scale);

  const maxElement = Math.max(...matrix.elements.map(Math.abs));

  return composed.elements.every(
    (element, index) => Math.abs(element - matrix.elements[index]) <= maxElement * 1e-6
  );
};
