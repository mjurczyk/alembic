import {
  Fn,
  int,
  ivec2,
  mix,
  materialNormal,
  negateOnBackSide,
  positionLocal,
  textureLoad,
  transformNormalToView,
  uniform,
  varyingProperty,
  vertexIndex,
} from 'three/tsl';
import { getVertexAnimation } from '../core/VertexAnimation.js';

// NOTE View space normal of the vertex animation, from the vertex stage to the fragment stage
const animatedNormalView = varyingProperty('vec3', 'v_alembicNormalView');

const uniformNodes = new WeakMap();

// NOTE Uniforms of one VertexAnimation. Values are read before each draw of the object.
const getUniforms = (animation) => {
  let uniforms = uniformNodes.get(animation);

  if (!uniforms) {
    uniforms = {
      floorLayer: uniform(0, 'int').onObjectUpdate(() => animation.floorLayer),
      ceilLayer: uniform(0, 'int').onObjectUpdate(() => animation.ceilLayer),
      alpha: uniform(0.0).onObjectUpdate(() => animation.alpha),
    };

    uniformNodes.set(animation, uniforms);
  }

  return uniforms;
};

// NOTE Blend of texel "vertex * stride + offset" in the floor and ceil layers (VertexAnimation texture layout)
const blendVertexTexels = (animation, { floorLayer, ceilLayer, alpha }, offset) => {
  const texelIndex = int(vertexIndex).mul(animation.stride).add(offset).toVar();
  const y = texelIndex.div(animation.width);
  const texel = ivec2(texelIndex.sub(y.mul(animation.width)), y).toVar();

  return mix(
    textureLoad(animation.texture, texel).depth(floorLayer).xyz,
    textureLoad(animation.texture, texel).depth(ceilLayer).xyz,
    alpha
  );
};

// NOTE Blend of the floor and ceil samples. Each object has its own shader (objectSpecific), so objects can share a material.
export const vertexAnimationPosition = Fn((builder) => {
  builder.objectSpecific = true;

  const animation = getVertexAnimation(builder.object);

  if (!animation) {
    return positionLocal;
  }

  const uniforms = getUniforms(animation);

  if (animation.hasNormals) {
    animatedNormalView.assign(transformNormalToView(blendVertexTexels(animation, uniforms, 1)));
  }

  return blendVertexTexels(animation, uniforms, 0);
});

// NOTE View space normal for material.normalNode. Without animated normals, the normal of the material.
export const vertexAnimationNormal = Fn((builder) => {
  const animation = getVertexAnimation(builder.object);

  if (!animation?.hasNormals) {
    return materialNormal;
  }

  return negateOnBackSide(animatedNormalView.normalize());
});
