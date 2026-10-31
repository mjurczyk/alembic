// NOTE Renderer backend: webgpu/ (TSL). The package entry point sets it. A backend has createMaterial( material ).
let animationBackend = null;

export const setAnimationBackend = (backend) => {
  animationBackend = backend;
};

export const getAnimationBackend = () => {
  if (!animationBackend) {
    throw new Error('ABCAnimation: no renderer backend. Import from "three-alembic".');
  }

  return animationBackend;
};
