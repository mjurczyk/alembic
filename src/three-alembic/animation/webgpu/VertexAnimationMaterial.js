import * as Three from 'three/webgpu';
import { vertexAnimationNormal, vertexAnimationPosition } from './vertexAnimationShaderChunks.js';

// NOTE Node material of each three.js material type, as the NodeLibrary of WebGPURenderer
const nodeMaterialTypes = {
  MeshBasicMaterial: Three.MeshBasicNodeMaterial,
  MeshLambertMaterial: Three.MeshLambertNodeMaterial,
  MeshMatcapMaterial: Three.MeshMatcapNodeMaterial,
  MeshNormalMaterial: Three.MeshNormalNodeMaterial,
  MeshPhongMaterial: Three.MeshPhongNodeMaterial,
  MeshPhysicalMaterial: Three.MeshPhysicalNodeMaterial,
  MeshStandardMaterial: Three.MeshStandardNodeMaterial,
  MeshToonMaterial: Three.MeshToonNodeMaterial,
  PointsMaterial: Three.PointsNodeMaterial,
};

// NOTE Material that shows the vertex animation, with lights and shadows. Other materials are copied into a node material.
export const createVertexAnimationMaterial = (material) => {
  let nodeMaterial = material;

  if (!material.isNodeMaterial) {
    const NodeMaterial = nodeMaterialTypes[material.type];

    if (!NodeMaterial) {
      throw new Error(`createVertexAnimationMaterial: ${material.type} is not supported.`);
    }

    nodeMaterial = new NodeMaterial();

    // NOTE Same copy as NodeLibrary.fromMaterial of three.js. The new material keeps its own type and uuid.
    for (const key in material) {
      if (key !== 'type' && key !== 'uuid') {
        nodeMaterial[key] = material[key];
      }
    }
  }

  nodeMaterial.positionNode = vertexAnimationPosition();
  // NOTE Animated normals replace normal maps
  nodeMaterial.normalNode = vertexAnimationNormal();
  nodeMaterial.needsUpdate = true;

  return nodeMaterial;
};

// NOTE Backend of the vertex animation (see core/animationBackend.js)
export const vertexAnimationBackend = {
  createMaterial: createVertexAnimationMaterial,
};
