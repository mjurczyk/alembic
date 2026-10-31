import { ABCAnimation } from './ABCAnimation.js';
import { ABCLoader } from './ABCLoader.js';
import { setAnimationBackend } from './animation/core/animationBackend.js';
import {
  createVertexAnimationMaterial,
  vertexAnimationBackend,
} from './animation/webgpu/VertexAnimationMaterial.js';

// NOTE This entry point renders the vertex animation with WebGPURenderer (TSL)
setAnimationBackend(vertexAnimationBackend);

export { ABCAnimation, ABCLoader, createVertexAnimationMaterial };
