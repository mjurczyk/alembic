import * as Three from 'three';
import { coarseBlockSize } from './volumeGrids';

// NOTE Code of the WebGPU (TSL) and the WebGL (GLSL) liquid views. Both views use the same values.
// NOTE Liquid: the surface is where the density is the surface level. It reflects the environment and the sun.
// NOTE Refraction goes through the liquid. Beer-Lambert absorption changes the scene behind it.
// NOTE The scene behind comes from the screen. Objects off the screen do not show in the refraction.

// NOTE Ray march step to the surface, in texels. Less than 1: thin liquid is not skipped.
export const surfaceStep = 0.75;
// NOTE Bisection steps between the last sample out of the liquid and the first sample in it
export const refineSteps = 6;
// NOTE Distance of the gradient samples, in texels. More than 1: smoother normals over the texel steps.
export const gradientOffset = 1.5;
// NOTE Roughness of the environment reflection
export const surfaceRoughness = 0.02;
// NOTE Blinn-Phong exponent of the sun highlight
export const highlightShininess = 2000.0;
// NOTE Normalization of the Blinn-Phong highlight: (n + 8) / (8 pi)
export const highlightScale = (highlightShininess + 8.0) / (8.0 * Math.PI);

// NOTE The longest ray in the box of size 1
const boxDiagonal = Math.sqrt(3.0);

export const toBox = ({ min, max }) =>
  new Three.Box3(new Three.Vector3(...min), new Three.Vector3(...max));

// NOTE A cube of resolution^3 bytes, x first
const createGridTexture = (resolution, filter) => {
  const texture = new Three.Data3DTexture(
    new Uint8Array(resolution ** 3),
    resolution,
    resolution,
    resolution
  );

  texture.format = Three.RedFormat;
  texture.minFilter = filter;
  texture.magFilter = filter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  return texture;
};

export const setTextureData = (texture, data) => {
  texture.image.data = data;
  texture.needsUpdate = true;
};

// NOTE Density texture and coarse texture (getCoarseGrid) of a grid, and the loop limits of a ray through the box
// NOTE Surface march limit: fine steps, and one jump for each coarse cell side on each axis
export const createLiquidGrids = (resolution) => {
  const coarseSize = Math.ceil(resolution / coarseBlockSize);

  return {
    texel: 1.0 / resolution,
    coarseSize,
    densityTexture: createGridTexture(resolution, Three.LinearFilter),
    coarseTexture: createGridTexture(coarseSize, Three.NearestFilter),
    surfaceSteps: Math.ceil((boxDiagonal * resolution) / surfaceStep) + 3 * coarseSize,
    insideSteps: Math.ceil(boxDiagonal * resolution),
  };
};

// NOTE Absorption of each channel for one world unit: -ln(tint) / tint distance
export const setLiquidAbsorption = (target, tint, tintDistance) => {
  target.set(...tint.toArray().map((channel) => -Math.log(Math.max(channel, 1e-3)) / tintDistance));
};

const sunPosition = new Three.Vector3();
const targetPosition = new Three.Vector3();

// NOTE Sun: the first directional light. Sky: the first hemisphere light. Without them, their color is black.
// NOTE "sunDirection" points to the sun, in world space.
export const readSceneLights = (scene, { sunDirection, sunColor, skyColor }) => {
  const [sun] = scene.getObjectsByProperty('isDirectionalLight', true);
  const [sky] = scene.getObjectsByProperty('isHemisphereLight', true);

  sunColor.setScalar(0.0);
  skyColor.setScalar(0.0);

  if (sun) {
    sun.getWorldPosition(sunPosition);
    sun.target.getWorldPosition(targetPosition);
    sunDirection.subVectors(sunPosition, targetPosition).normalize();
    sunColor.copy(sun.color).multiplyScalar(sun.intensity);
  }

  if (sky) {
    skyColor.copy(sky.color).multiplyScalar(sky.intensity);
  }
};
