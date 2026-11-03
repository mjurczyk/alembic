import { ABCAnimation } from './ABCAnimation.js';
import { ABCLoader } from './ABCLoader.js';
import { WABCAnimation } from './WABCAnimation.js';
import { WABCLoader, createWabcGeometry } from './WABCLoader.js';
import { setAnimationBackend } from './animation/core/animationBackend.js';
import {
  createVertexAnimationMaterial,
  vertexAnimationBackend,
} from './animation/webgl/VertexAnimationMaterial.js';

// NOTE WebGLRenderer entry point (three-alembic/webgl), with GLSL. The same API as index.js.
// NOTE Delete this file and animation/webgl/ to drop WebGLRenderer.
setAnimationBackend(vertexAnimationBackend);

export {
  ABCAnimation,
  ABCLoader,
  WABCAnimation,
  WABCLoader,
  createVertexAnimationMaterial,
  createWabcGeometry,
};
