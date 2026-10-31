import * as Three from 'three';
import { decomposeExact } from '../../scene/matrices.js';

const from = new Three.Matrix4();
const to = new Three.Matrix4();
const fromParts = [new Three.Vector3(), new Three.Quaternion(), new Three.Vector3()];
const toParts = [new Three.Vector3(), new Three.Quaternion(), new Three.Vector3()];

// NOTE Blend of Xform matrices "a" (alpha 0) and "b" (alpha 1), as Blender: position and scale lerp, rotation slerp.
export const blendMatrices = (a, b, alpha, target) => {
  if (alpha <= 0.0) {
    return target.fromArray(a);
  }

  if (alpha >= 1.0) {
    return target.fromArray(b);
  }

  from.fromArray(a);
  to.fromArray(b);

  if (decomposeExact(from, ...fromParts) && decomposeExact(to, ...toParts)) {
    const [position, quaternion, scale] = fromParts;

    return target.compose(
      position.lerp(toParts[0], alpha),
      quaternion.slerp(toParts[1], alpha),
      scale.lerp(toParts[2], alpha)
    );
  }

  // NOTE Shear: no exact rotation and scale, so the elements are blended
  target.elements.forEach((_, index) => {
    target.elements[index] = a[index] + (b[index] - a[index]) * alpha;
  });

  return target;
};
