import * as Three from 'three';
import {
  addVertexAnimation,
  createVertexAnimationUniforms,
} from './vertexAnimationShaderChunks.js';

// NOTE Material types with the vertex animation, as the node materials of webgpu/VertexAnimationMaterial.js
const materialTypes = [
  'MeshBasicMaterial',
  'MeshLambertMaterial',
  'MeshMatcapMaterial',
  'MeshNormalMaterial',
  'MeshPhongMaterial',
  'MeshPhysicalMaterial',
  'MeshStandardMaterial',
  'MeshToonMaterial',
  'PointsMaterial',
];

const vertexAnimationMaterials = new WeakSet();

const hasVertexAnimationMaterial = ({ material }) =>
  Array.isArray(material)
    ? material.some((item) => vertexAnimationMaterials.has(item))
    : vertexAnimationMaterials.has(material);

// NOTE The default program cache key is the source of onBeforeCompile.
// Minified code of other materials can have the same source, so the key is set.
const setShader = (material, uniforms) => {
  material.onBeforeCompile = (shader) => addVertexAnimation(shader, uniforms);
  material.customProgramCacheKey = () => 'three-alembic-vertex-animation';
};

// NOTE Material that shows the vertex animation, with lights and shadows. The material is changed and given back.
export const createVertexAnimationMaterial = (material) => {
  if (!materialTypes.includes(material.type)) {
    throw new Error(`createVertexAnimationMaterial: ${material.type} is not supported.`);
  }

  let drawnObject = null;
  const uniforms = createVertexAnimationUniforms(() => drawnObject);

  setShader(material, uniforms);

  // NOTE WebGLRenderer sends material uniforms only when the material or the program changes.
  // Objects can share this material, so the program is released. Then the uniforms of each object are sent.
  material.onBeforeRender = (renderer, scene, camera, geometry, object) => {
    drawnObject = object;
    renderer.state.useProgram(null);
  };

  material.needsUpdate = true;
  vertexAnimationMaterials.add(material);

  return material;
};

// NOTE Shadow material of one node. Without a vertex animation material on the node, the shadow does not move.
const createShadowMaterial = (material, node) => {
  setShader(
    material,
    createVertexAnimationUniforms(() => (hasVertexAnimationMaterial(node) ? node : null))
  );

  return material;
};

// NOTE WebGLRenderer draws shadows with customDepthMaterial and customDistanceMaterial.
// The shadow maps of three.js before r182 read RGBA packed depth. Later shadow maps read the depth buffer.
const setupObject = (node) => {
  node.customDepthMaterial = createShadowMaterial(
    new Three.MeshDepthMaterial({ depthPacking: Three.RGBADepthPacking }),
    node
  );
  node.customDistanceMaterial = createShadowMaterial(new Three.MeshDistanceMaterial(), node);
};

// NOTE Backend of the vertex animation (see core/animationBackend.js)
export const vertexAnimationBackend = {
  createMaterial: createVertexAnimationMaterial,
  setupObject,
};
