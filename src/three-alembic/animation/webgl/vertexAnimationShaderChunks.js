import { getVertexAnimation } from '../core/VertexAnimation.js';

// NOTE Blend of texel "vertex * stride + offset" in the floor and ceil layers (VertexAnimation texture layout). Needs WebGL2.
const vertexAnimationParsVertex = /* glsl */ `
  uniform bool alembicAnimated;
  uniform bool alembicNormals;
  uniform highp sampler2DArray alembicTexture;
  uniform int alembicWidth;
  uniform int alembicStride;
  uniform int alembicFloorLayer;
  uniform int alembicCeilLayer;
  uniform float alembicAlpha;

  vec3 alembicBlendTexels( int offset ) {
    int texelIndex = gl_VertexID * alembicStride + offset;
    int y = texelIndex / alembicWidth;
    ivec2 texel = ivec2( texelIndex - y * alembicWidth, y );

    return mix(
      texelFetch( alembicTexture, ivec3( texel, alembicFloorLayer ), 0 ).xyz,
      texelFetch( alembicTexture, ivec3( texel, alembicCeilLayer ), 0 ).xyz,
      alembicAlpha
    );
  }
`;

const vertexAnimationParsFragment = /* glsl */ `
  uniform bool alembicNormals;
`;

// NOTE Blend of the floor and ceil samples. Without the animation, the position of the geometry.
const vertexAnimationPosition = /* glsl */ `
  #include <begin_vertex>

  if ( alembicAnimated ) {
    transformed = alembicBlendTexels( 0 );
  }
`;

const vertexAnimationNormal = /* glsl */ `
  #include <beginnormal_vertex>

  if ( alembicNormals ) {
    objectNormal = alembicBlendTexels( 1 );
  }
`;

// NOTE Animated normals replace normal maps and bump maps
const vertexAnimationNormalMaps = /* glsl */ `
  if ( ! alembicNormals ) {
    #include <normal_fragment_maps>
  }
`;

// NOTE Uniforms of the vertex animation of getObject(), the object that is drawn. The values are read when WebGLRenderer sends them.
export const createVertexAnimationUniforms = (getObject) => {
  const createUniform = (read, defaultValue) => ({
    get value() {
      const animation = getVertexAnimation(getObject());

      return animation ? read(animation) : defaultValue;
    },
  });

  return {
    alembicAnimated: createUniform(() => true, false),
    alembicNormals: createUniform((animation) => animation.hasNormals, false),
    alembicTexture: createUniform((animation) => animation.texture, null),
    alembicWidth: createUniform((animation) => animation.width, 1),
    alembicStride: createUniform((animation) => animation.stride, 1),
    alembicFloorLayer: createUniform((animation) => animation.floorLayer, 0),
    alembicCeilLayer: createUniform((animation) => animation.ceilLayer, 0),
    alembicAlpha: createUniform((animation) => animation.alpha, 0.0),
  };
};

// NOTE Adds the vertex animation to the shader of a three.js material (material.onBeforeCompile)
export const addVertexAnimation = (shader, uniforms) => {
  Object.assign(shader.uniforms, uniforms);

  shader.vertexShader = `${vertexAnimationParsVertex}\n${shader.vertexShader}`
    .replace('#include <begin_vertex>', vertexAnimationPosition)
    .replace('#include <beginnormal_vertex>', vertexAnimationNormal);

  shader.fragmentShader = `${vertexAnimationParsFragment}\n${shader.fragmentShader}`.replace(
    '#include <normal_fragment_maps>',
    vertexAnimationNormalMaps
  );
};
