import { ABCAnimation } from './ABCAnimation.js';
import { ABCLoader } from './ABCLoader.js';
import { WABCAnimation } from './WABCAnimation.js';
import { WABCLoader, createWabcGeometry } from './WABCLoader.js';
import { setAnimationBackend } from './animation/core/animationBackend.js';
import {
  createVertexAnimationMaterial,
  vertexAnimationBackend,
} from './animation/webgpu/VertexAnimationMaterial.js';

// NOTE This entry point renders the vertex animation with WebGPURenderer (TSL)
setAnimationBackend(vertexAnimationBackend);

export {
  ABCAnimation,
  ABCLoader,
  WABCAnimation,
  WABCLoader,
  createVertexAnimationMaterial,
  createWabcGeometry,
};
