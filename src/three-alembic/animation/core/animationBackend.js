// NOTE Renderer backend: webgpu/ (TSL) or webgl/ (GLSL). The package entry point sets it: index.js or webgl.js.
// NOTE A backend has createMaterial( material ) and setupObject( node ). ABCAnimation calls setupObject once for each animated node.
let animationBackend = null;

export const setAnimationBackend = (backend) => {
  animationBackend = backend;
};

export const getAnimationBackend = () => {
  if (!animationBackend) {
    throw new Error(
      'ABCAnimation: no renderer backend. Import from "three-alembic" (WebGPURenderer) or "three-alembic/webgl" (WebGLRenderer).'
    );
  }

  return animationBackend;
};
