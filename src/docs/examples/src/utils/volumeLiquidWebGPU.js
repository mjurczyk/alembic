import * as Three from 'three';
import { NodeMaterial } from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  bool,
  cameraPosition,
  cameraProjectionMatrix,
  cameraProjectionMatrixInverse,
  cameraViewMatrix,
  cameraWorldMatrix,
  float,
  getScreenPosition,
  getViewPosition,
  max,
  min,
  mix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  pmremTexture,
  positionGeometry,
  reflect,
  refract,
  screenUV,
  select,
  step,
  texture3D,
  transpose,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  viewportDepthTexture,
  viewportSharedTexture,
} from 'three/tsl';
import {
  createLiquidGrids,
  gradientOffset,
  highlightScale,
  highlightShininess,
  readSceneLights,
  refineSteps,
  setLiquidAbsorption,
  setTextureData,
  surfaceRoughness,
  surfaceStep,
  toBox,
} from './volumeLiquid';

// NOTE Liquid view (WebGPU, TSL). See volumeLiquid.js.

// NOTE A zero component gives a very large distance to a box side, not a division by zero
const toNonZero = (direction) => direction.add(step(direction.abs(), vec3(1e-6)).mul(1e-6));

// NOTE Box of size 1 at the origin, in local space. Distances to the entry and the exit of the ray.
const hitUnitBox = Fn(([origin, direction]) => {
  const inverse = toNonZero(direction).reciprocal();
  const near = vec3(-0.5).sub(origin).mul(inverse);
  const far = vec3(0.5).sub(origin).mul(inverse);
  const entry = min(near, far);
  const exit = max(near, far);

  return vec2(max(entry.x, max(entry.y, entry.z)), min(exit.x, min(exit.y, exit.z)));
});

// NOTE Schlick approximation of the Fresnel reflectance
const getFresnel = (reflectance, cosine) =>
  reflectance.add(reflectance.oneMinus().mul(cosine.clamp(0.0, 1.0).oneMinus().pow(5.0)));

const toWorldDirection = (direction) => modelWorldMatrix.mul(vec4(direction, 0.0)).xyz;
const toLocalDirection = (direction) =>
  modelWorldMatrixInverse.mul(vec4(direction, 0.0)).xyz.normalize();
// NOTE Normals use the inverse transpose of the model matrix
const toWorldNormal = (normal) =>
  transpose(modelWorldMatrixInverse).mul(vec4(normal, 0.0)).xyz.normalize();

// NOTE "params": surfaceLevel, ior, color (tint), tintDistance, scatter
export const createLiquidWebGPUView = ({ resolution, bbox, params, scene }) => {
  const { texel, coarseSize, densityTexture, coarseTexture, surfaceSteps, insideSteps } =
    createLiquidGrids(resolution);
  // NOTE The PMREM node needs a texture. Without a scene environment, the reflection intensity is 0.
  const placeholderEnvironment = new Three.DataTexture(new Uint8Array(8), 2, 1);
  const box = toBox(bbox);

  placeholderEnvironment.mapping = Three.EquirectangularReflectionMapping;
  placeholderEnvironment.needsUpdate = true;

  const getEnvironment = () =>
    scene.environment?.isTexture ? scene.environment : placeholderEnvironment;

  const uniforms = {
    level: uniform(0.5),
    ior: uniform(1.333),
    absorption: uniform(new Three.Vector3()),
    tint: uniform(new Three.Color()),
    scatter: uniform(0.0),
    sunDirection: uniform(new Three.Vector3(0.0, 1.0, 0.0)),
    sunColor: uniform(new Three.Color()),
    skyColor: uniform(new Three.Color()),
    environmentIntensity: uniform(1.0),
  };
  // NOTE Made when the material is built. A new scene environment goes into it.
  let environmentNode = null;

  const sampleDensity = (position) => texture3D(densityTexture, position.add(0.5), 0).r;
  const isInLiquid = (position) => sampleDensity(position).greaterThanEqual(uniforms.level);

  // NOTE Outward normal in local space: the density goes up into the liquid. "fallback" where the density is flat.
  const getNormal = (position, fallback) => {
    const offset = texel * gradientOffset;
    const gradient = vec3(
      sampleDensity(position.sub(vec3(offset, 0.0, 0.0))).sub(
        sampleDensity(position.add(vec3(offset, 0.0, 0.0)))
      ),
      sampleDensity(position.sub(vec3(0.0, offset, 0.0))).sub(
        sampleDensity(position.add(vec3(0.0, offset, 0.0)))
      ),
      sampleDensity(position.sub(vec3(0.0, 0.0, offset))).sub(
        sampleDensity(position.add(vec3(0.0, 0.0, offset)))
      )
    ).toVar();

    return select(gradient.dot(gradient).greaterThan(1e-10), gradient.normalize(), fallback);
  };

  const origin = varying(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)).xyz);
  const direction = varying(positionGeometry.sub(origin));

  const liquidNode = Fn(() => {
    const rayDirection = direction.normalize().toVar();
    // NOTE World units for one local unit on the view ray
    const rayScale = toWorldDirection(rayDirection).length();

    // NOTE Scene depth before the discard: textures are read in uniform control flow
    const sceneDepth = viewportDepthTexture(screenUV, 0).x;
    const sceneView = getViewPosition(screenUV, sceneDepth, cameraProjectionMatrixInverse);
    const sceneLocal = modelWorldMatrixInverse.mul(cameraWorldMatrix.mul(vec4(sceneView, 1.0))).xyz;
    const sceneDistance = sceneLocal.sub(origin).dot(rayDirection);
    const bounds = hitUnitBox(origin, rayDirection).toVar();
    const end = min(bounds.y, sceneDistance).toVar();
    // NOTE Camera in the liquid: no surface. The ray goes straight to the scene or out of the liquid.
    const underwater = bounds.x.lessThan(0.0).and(isInLiquid(origin)).toVar();

    // NOTE March to the surface. Empty coarse cells are skipped.
    const distance = max(bounds.x, 0.0).toVar();
    const previous = distance.toVar();
    const hit = bool(false).toVar();
    const cellDirection = toNonZero(rayDirection);

    Loop(surfaceSteps, () => {
      If(distance.greaterThan(end), () => {
        Break();
      });

      const position = origin.add(rayDirection.mul(distance));
      const coarse = texture3D(coarseTexture, position.add(0.5), 0).r;

      If(coarse.equal(0.0), () => {
        const cellMin = position.add(0.5).mul(coarseSize).floor().div(coarseSize).sub(0.5);
        const cellSide = mix(cellMin, cellMin.add(1.0 / coarseSize), step(0.0, rayDirection));
        const exits = cellSide.sub(position).div(cellDirection);

        previous.assign(distance);
        distance.addAssign(max(min(exits.x, min(exits.y, exits.z)), 0.0).add(1e-4));
      }).Else(() => {
        If(isInLiquid(position), () => {
          hit.assign(true);
          Break();
        });

        previous.assign(distance);
        distance.addAssign(texel * surfaceStep);
      });
    });

    hit.not().discard();

    // NOTE The surface is between the last sample out of the liquid and the first sample in it
    const outside = previous.toVar();
    const inside = distance.toVar();

    Loop(refineSteps, () => {
      const middle = outside.add(inside).mul(0.5);
      const middleInLiquid = isInLiquid(origin.add(rayDirection.mul(middle)));

      inside.assign(select(middleInLiquid, middle, inside));
      outside.assign(select(middleInLiquid, outside, middle));
    });

    const surface = origin.add(rayDirection.mul(inside)).toVar();
    const surfaceWorld = modelWorldMatrix.mul(vec4(surface, 1.0)).xyz;
    // NOTE From the ray, not from the camera position: in the liquid, the surface point is the camera
    const view = toWorldDirection(rayDirection).normalize().negate().toVar();
    const incident = view.negate();
    const normal = select(
      underwater,
      view,
      toWorldNormal(getNormal(surface, rayDirection.negate()))
    ).toVar();
    const reflectance = uniforms.ior.sub(1.0).div(uniforms.ior.add(1.0)).pow2();
    const surfaceWeight = select(underwater, 0.0, 1.0);
    const fresnel = getFresnel(reflectance, normal.dot(view)).mul(surfaceWeight);

    // NOTE Reflection: environment (with scene.environmentRotation) and a normalized Blinn-Phong sun highlight
    environmentNode = pmremTexture(
      getEnvironment(),
      reflect(incident, normal),
      float(surfaceRoughness)
    );

    const halfVector = uniforms.sunDirection.add(view).normalize();
    const highlight = normal
      .dot(halfVector)
      .clamp(0.0, 1.0)
      .pow(highlightShininess)
      .mul(highlightScale)
      .mul(normal.dot(uniforms.sunDirection).clamp(0.0, 1.0))
      .mul(getFresnel(reflectance, view.dot(halfVector)))
      .mul(surfaceWeight);
    const reflection = environmentNode
      .mul(uniforms.environmentIntensity)
      .mul(fresnel)
      .add(uniforms.sunColor.mul(highlight));

    // NOTE Refraction: the bent ray goes through the liquid to its exit. Objects in the liquid stop it at the
    // scene distance of the view ray.
    const refracted = refract(incident, normal, uniforms.ior.reciprocal()).normalize().toVar();
    const insideDirection = toLocalDirection(refracted).toVar();
    const insideEnd = min(hitUnitBox(surface, insideDirection).y, end.sub(inside));
    const travelled = float(texel).toVar();

    Loop(insideSteps, () => {
      If(
        travelled
          .greaterThan(insideEnd)
          .or(isInLiquid(surface.add(insideDirection.mul(travelled))).not()),
        () => {
          Break();
        }
      );

      travelled.addAssign(texel);
    });

    const insideLength = travelled.min(insideEnd).max(0.0);
    const thickness = insideLength.mul(toWorldDirection(insideDirection).length());
    const exitLocal = surface.add(insideDirection.mul(insideLength));
    const exitWorld = modelWorldMatrix.mul(vec4(exitLocal, 1.0)).xyz;
    // NOTE Out of the liquid: the second refraction. With total internal reflection, the ray does not bend.
    const exitNormal = toWorldNormal(getNormal(exitLocal, insideDirection));
    const bent = refract(refracted, exitNormal.negate(), uniforms.ior);
    const outDirection = select(bent.dot(bent).greaterThan(0.0), bent.normalize(), refracted);
    // NOTE With no scene object behind the liquid, the far plane gives a point far away in the out direction
    const sceneWorldDistance = max(sceneDistance.sub(inside), 0.0).mul(rayScale);
    const behind = exitWorld.add(outDirection.mul(max(sceneWorldDistance.sub(thickness), 0.01)));
    const behindView = cameraViewMatrix.mul(vec4(behind, 1.0)).xyz;
    const refractedUV = getScreenPosition(behindView, cameraProjectionMatrix)
      .clamp(0.0, 1.0)
      .toVar();
    // NOTE A scene object in front of the surface must not show through the liquid
    const surfaceViewZ = cameraViewMatrix.mul(vec4(surfaceWorld, 1.0)).z;
    const behindDepth = viewportDepthTexture(refractedUV, 0).x;
    const behindViewZ = getViewPosition(refractedUV, behindDepth, cameraProjectionMatrixInverse).z;
    const backdropUV = select(behindViewZ.greaterThan(surfaceViewZ), screenUV, refractedUV);
    const backdrop = viewportSharedTexture(backdropUV, 0).rgb;
    const transmittance = uniforms.absorption.mul(thickness).negate().exp();
    // NOTE Murky liquid: sky and sun light scattered in the liquid
    const scattered = transmittance
      .oneMinus()
      .mul(uniforms.tint)
      .mul(uniforms.scatter)
      .mul(
        uniforms.skyColor.add(
          uniforms.sunColor.mul(normal.dot(uniforms.sunDirection).clamp(0.0, 1.0))
        )
      );
    const transmitted = backdrop.mul(transmittance).add(scattered).mul(fresnel.oneMinus());

    return vec4(reflection.add(transmitted), 1.0);
  })();

  const material = new NodeMaterial();

  material.fragmentNode = liquidNode;
  // NOTE Back faces: the box also shows when the camera is in it
  material.side = Three.BackSide;
  material.transparent = true;
  // NOTE The shader stops the ray at the scene depth. A depth test of the box sides removes liquid in front of
  // objects in the box.
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  // NOTE With no material environment map, the PMREM node uses scene.environmentRotation
  material.envMap = null;

  const mesh = new Three.Mesh(new Three.BoxGeometry(1.0, 1.0, 1.0), material);

  box.getCenter(mesh.position);
  box.getSize(mesh.scale);

  const view = {
    object: mesh,
    setDensity: (data, coarse) => {
      setTextureData(densityTexture, data);
      setTextureData(coarseTexture, coarse);
    },
    setParams: (params) => {
      const { tint } = uniforms;

      uniforms.level.value = params.surfaceLevel;
      uniforms.ior.value = params.ior;
      uniforms.scatter.value = params.scatter;
      tint.value.set(params.color);
      setLiquidAbsorption(uniforms.absorption.value, tint.value, params.tintDistance);
    },
    update: () => {
      readSceneLights(scene, {
        sunDirection: uniforms.sunDirection.value,
        sunColor: uniforms.sunColor.value,
        skyColor: uniforms.skyColor.value,
      });

      // NOTE A new value makes the PMREM again
      if (environmentNode && environmentNode.value !== getEnvironment()) {
        environmentNode.value = getEnvironment();
      }

      uniforms.environmentIntensity.value = scene.environment?.isTexture
        ? scene.environmentIntensity
        : 0.0;
    },
    dispose: () => {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      material.dispose();
      densityTexture.dispose();
      coarseTexture.dispose();
      placeholderEnvironment.dispose();
    },
  };

  view.setParams(params);

  return view;
};
