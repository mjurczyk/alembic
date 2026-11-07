import * as Three from 'three';
import { NodeMaterial, RenderPipeline, VolumeNodeMaterial } from 'three/webgpu';
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
  equirectUV,
  float,
  getScreenPosition,
  getViewPosition,
  max,
  min,
  mix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  pass,
  positionGeometry,
  reflect,
  refract,
  screenCoordinate,
  screenUV,
  select,
  step,
  texture,
  texture3D,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  viewportDepthTexture,
  viewportSharedTexture,
} from 'three/tsl';
import { bayer16 } from 'three/examples/jsm/tsl/math/Bayer.js';
import { FrameVolume } from 'three-openvdb';
import { coarseBlockSize } from './volumeGrids';

// NOTE Views of one density grid (resolution^3 bytes) in a world box. "frame": FrameVolume of three-openvdb.
// "builtin": three.js only. "liquid": surface prototype, WebGPU only.

const useWebGLRenderer = import.meta.env.VITE_RENDERER === 'webgl';

const toBox = ({ min, max }) =>
  new Three.Box3(new Three.Vector3(...min), new Three.Vector3(...max));

const createDensityTexture = (resolution) => {
  const texture = new Three.Data3DTexture(
    new Uint8Array(resolution ** 3),
    resolution,
    resolution,
    resolution
  );

  texture.format = Three.RedFormat;
  texture.minFilter = Three.LinearFilter;
  texture.magFilter = Three.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  return texture;
};

const setTextureData = (texture, data) => {
  texture.image.data = data;
  texture.needsUpdate = true;
};

// NOTE Box mesh of size 1 at the place of the grid box
const placeInBox = (object, box) => {
  box.getCenter(object.position);
  box.getSize(object.scale);
};

// NOTE FrameVolume: froxel renderer of three-openvdb. Scene lights, self shadows, absorption of the scene behind it.
const createFrameView = ({ resolution, bbox, params }) => {
  const volume = new FrameVolume(new Uint8Array(resolution ** 3), {
    resolution,
    bbox: toBox(bbox),
    mipmaps: params.mipmaps,
  });

  const view = {
    object: volume,
    setDensity: (data) => setTextureData(volume.volumes[0].densityMap3D, data),
    setParams: (params) => {
      volume.baseColor.set(params.color);
      volume.extinction = params.extinction;
      volume.densityScale = params.densityScale;
      volume.absorbance = params.absorbance;
      volume.shadowSteps = params.shadowSteps;
      volume.mipmaps = params.mipmaps;
    },
    update: () => {},
    dispose: () => {
      volume.removeFromParent();
      volume.dispose();
    },
  };

  view.setParams(params);

  return view;
};

// NOTE WebGPURenderer: VolumeNodeMaterial adds scattered point and spot light. It does not darken the scene.
// Own pass, added to the scene pass, as in three.js examples.
const createNodeView = ({ resolution, bbox, params, renderer, scene, camera, setRenderFrame }) => {
  const texture = createDensityTexture(resolution);
  const uniforms = {
    color: uniform(new Three.Color()),
    density: uniform(1.0),
  };
  const box = toBox(bbox);
  const material = new VolumeNodeMaterial();

  material.offsetNode = bayer16(screenCoordinate);
  material.scatteringNode = Fn(({ positionRay }) => {
    const local = modelWorldMatrixInverse.mul(vec4(positionRay, 1.0)).xyz.add(0.5);
    const inside = step(vec3(0.0), local).mul(step(local, vec3(1.0)));
    const density = texture3D(texture, local, 0).r.mul(inside.x).mul(inside.y).mul(inside.z);

    return uniforms.color.mul(density.mul(uniforms.density));
  });

  const mesh = new Three.Mesh(new Three.BoxGeometry(1.0, 1.0, 1.0), material);
  const volumeScene = new Three.Scene();
  // NOTE VolumeNodeMaterial does not use directional and environment light. This light is above the box, in the
  // volume pass only.
  const light = new Three.PointLight(0xffffff, params.lightIntensity);

  placeInBox(mesh, box);
  light.position.copy(mesh.position);
  light.position.y += mesh.scale.y * 0.6;
  volumeScene.add(mesh, light);

  const scenePass = pass(scene, camera);
  const volumePass = pass(volumeScene, camera, { depthBuffer: false });
  const pipeline = new RenderPipeline(renderer);

  material.depthNode = scenePass.getTextureNode('depth').sample(screenUV);
  pipeline.outputNode = scenePass.add(volumePass);
  setRenderFrame(() => pipeline.render());

  const view = {
    // NOTE The mesh is in its own scene. This empty object is the place of the view in the main scene.
    object: new Three.Group(),
    setDensity: (data) => setTextureData(texture, data),
    setParams: (params) => {
      material.steps = params.steps;
      uniforms.color.value.set(params.color);
      uniforms.density.value = params.densityScale * params.extinction;
      volumePass.setResolutionScale(params.passScale);
      light.intensity = params.lightIntensity;
    },
    update: () => {},
    dispose: () => {
      setRenderFrame(null);
      view.object.removeFromParent();
      pipeline.dispose();
      scenePass.dispose();
      volumePass.dispose();
      mesh.geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };

  view.setParams(params);

  return view;
};

const glslVertexShader = /* glsl */ `
  out vec3 vOrigin;
  out vec3 vDirection;

  void main() {
    vOrigin = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
    vDirection = position - vOrigin;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// NOTE Ray march in the local box. One directional light with a shadow march, plus ambient light.
// Color is not premultiplied, for correct color space conversion.
const glslFragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  uniform sampler3D densityMap;
  uniform float density;
  uniform float absorbance;
  uniform int steps;
  uniform int shadowSteps;
  uniform vec3 baseColor;
  uniform vec3 lightDirection;
  uniform vec3 lightColor;
  uniform vec3 ambientColor;

  in vec3 vOrigin;
  in vec3 vDirection;

  vec2 hitBox(vec3 origin, vec3 direction) {
    vec3 inverseDirection = 1.0 / direction;
    vec3 near = (vec3(-0.5) - origin) * inverseDirection;
    vec3 far = (vec3(0.5) - origin) * inverseDirection;
    vec3 entry = min(near, far);
    vec3 exit = max(near, far);

    return vec2(max(max(entry.x, entry.y), entry.z), min(min(exit.x, exit.y), exit.z));
  }

  float sampleExtinction(vec3 position) {
    return texture(densityMap, position + 0.5).r * density;
  }

  float hash(vec2 value) {
    return fract(sin(dot(value, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec3 direction = normalize(vDirection);
    vec2 bounds = hitBox(vOrigin, direction);

    bounds.x = max(bounds.x, 0.0);

    if (bounds.x >= bounds.y) {
      discard;
    }

    float stepLength = (bounds.y - bounds.x) / float(steps);
    float travelled = bounds.x + stepLength * hash(gl_FragCoord.xy);
    float transmittance = 1.0;
    vec3 light = vec3(0.0);

    for (int i = 0; i < 512; i++) {
      if (i >= steps || transmittance < 0.01) {
        break;
      }

      vec3 position = vOrigin + direction * travelled;
      float extinction = sampleExtinction(position);

      if (extinction > 0.0) {
        float shadowLength = hitBox(position, lightDirection).y / float(shadowSteps);
        float opticalDepth = 0.0;

        for (int j = 1; j <= 128; j++) {
          if (j > shadowSteps) {
            break;
          }

          opticalDepth += sampleExtinction(position + lightDirection * shadowLength * float(j)) * shadowLength;
        }

        vec3 direct = lightColor * exp(-opticalDepth * absorbance);
        float stepTransmittance = exp(-extinction * stepLength);

        light += transmittance * (1.0 - stepTransmittance) * baseColor * (direct + ambientColor);
        transmittance *= stepTransmittance;
      }

      travelled += stepLength;
    }

    float alpha = 1.0 - transmittance;

    if (alpha <= 0.001) {
      discard;
    }

    gl_FragColor = vec4(light / alpha, alpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// NOTE WebGLRenderer: no three.js volume material. A ShaderMaterial marches a Data3DTexture.
// Objects inside the box do not cut the volume. Light: scene sun and sky.
const createShaderView = ({ resolution, bbox, params, scene }) => {
  const texture = createDensityTexture(resolution);
  const box = toBox(bbox);
  const material = new Three.ShaderMaterial({
    glslVersion: Three.GLSL3,
    vertexShader: glslVertexShader,
    fragmentShader: glslFragmentShader,
    uniforms: {
      densityMap: { value: texture },
      density: { value: 1.0 },
      absorbance: { value: 1.0 },
      steps: { value: 64 },
      shadowSteps: { value: 16 },
      baseColor: { value: new Three.Color() },
      lightDirection: { value: new Three.Vector3(0.0, 1.0, 0.0) },
      lightColor: { value: new Three.Color() },
      ambientColor: { value: new Three.Color() },
    },
    transparent: true,
    depthWrite: false,
  });
  const mesh = new Three.Mesh(new Three.BoxGeometry(1.0, 1.0, 1.0), material);
  const { uniforms } = material;
  const sunPosition = new Three.Vector3();
  const targetPosition = new Three.Vector3();

  placeInBox(mesh, box);

  const view = {
    object: mesh,
    setDensity: (data) => setTextureData(texture, data),
    setParams: (params) => {
      uniforms.steps.value = params.steps;
      uniforms.shadowSteps.value = params.shadowSteps;
      uniforms.density.value = params.densityScale * params.extinction;
      uniforms.absorbance.value = params.absorbance;
      uniforms.baseColor.value.set(params.color);
    },
    update: () => {
      const [sun] = scene.getObjectsByProperty('isDirectionalLight', true);
      const [sky] = scene.getObjectsByProperty('isHemisphereLight', true);

      uniforms.lightColor.value.setScalar(0.0);
      uniforms.ambientColor.value.setScalar(0.0);

      // NOTE The box has no rotation, so a world direction is also a local direction
      if (sun) {
        sun.getWorldPosition(sunPosition);
        sun.target.getWorldPosition(targetPosition);
        uniforms.lightDirection.value.subVectors(sunPosition, targetPosition).normalize();
        uniforms.lightColor.value.copy(sun.color).multiplyScalar(sun.intensity);
      }

      if (sky) {
        uniforms.ambientColor.value.copy(sky.color).multiplyScalar(sky.intensity);
      }
    },
    dispose: () => {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };

  view.setParams(params);

  return view;
};

// NOTE Box of size 1 at the origin, in local space. Distances to the entry and the exit of the ray.
const hitUnitBox = Fn(([origin, direction]) => {
  const inverse = direction.reciprocal();
  const near = vec3(-0.5).sub(origin).mul(inverse);
  const far = vec3(0.5).sub(origin).mul(inverse);
  const entry = min(near, far);
  const exit = max(near, far);

  return vec2(max(entry.x, max(entry.y, entry.z)), min(exit.x, min(exit.y, exit.z)));
});

// NOTE Liquid (prototype, WebGPU): a surface where the density is the surface level. Fresnel reflection of the
// environment and the sun. Refraction through the liquid, with Beer-Lambert absorption of the scene behind.
const createLiquidView = ({ resolution, bbox, params, scene }) => {
  const densityTexture = createDensityTexture(resolution);
  const coarseSize = Math.ceil(resolution / coarseBlockSize);
  const coarseTexture = createDensityTexture(coarseSize);
  const placeholderEnvironment = new Three.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const box = toBox(bbox);
  const boxSize = box.getSize(new Three.Vector3());

  const getEnvironment = () =>
    scene.environment?.isTexture ? scene.environment : placeholderEnvironment;

  coarseTexture.minFilter = Three.NearestFilter;
  coarseTexture.magFilter = Three.NearestFilter;
  placeholderEnvironment.needsUpdate = true;

  const uniforms = {
    level: uniform(0.5),
    ior: uniform(1.333),
    // NOTE Absorption of each channel for one world unit: -ln(tint) / tint distance
    absorption: uniform(new Three.Vector3()),
    tint: uniform(new Three.Color()),
    scatter: uniform(0.1),
    boxSize: uniform(boxSize),
    sunDirection: uniform(new Three.Vector3(0.0, 1.0, 0.0)),
    sunColor: uniform(new Three.Color()),
    skyColor: uniform(new Three.Color()),
    environmentIntensity: uniform(1.0),
  };
  // NOTE Environment texture nodes of the shader. They are made when the material is built.
  const environmentNodes = [];
  const texel = 1.0 / resolution;
  const sampleDensity = (position) => texture3D(densityTexture, position.add(0.5), 0).r;

  // NOTE Outward normal in local space: the density goes up into the liquid. "fallback" where the density is flat.
  const getNormal = (position, fallback) => {
    const dx = vec3(texel * 1.5, 0.0, 0.0);
    const dy = vec3(0.0, texel * 1.5, 0.0);
    const dz = vec3(0.0, 0.0, texel * 1.5);

    const gradient = vec3(
      sampleDensity(position.sub(dx)).sub(sampleDensity(position.add(dx))),
      sampleDensity(position.sub(dy)).sub(sampleDensity(position.add(dy))),
      sampleDensity(position.sub(dz)).sub(sampleDensity(position.add(dz)))
    ).toVar();

    return select(gradient.dot(gradient).greaterThan(1e-10), gradient.normalize(), fallback);
  };

  // NOTE The box has no rotation. A local vector becomes a world vector with the box size.
  const toWorldNormal = (normal) => normal.div(uniforms.boxSize).normalize();
  const toLocalDirection = (direction) => direction.div(uniforms.boxSize).normalize();

  const origin = varying(modelWorldMatrixInverse.mul(vec4(cameraPosition, 1.0)).xyz);
  const direction = varying(positionGeometry.sub(origin));

  const liquidNode = Fn(() => {
    const rayDirection = direction.normalize().toVar();
    // NOTE Scene depth before any discard: textures are read in uniform control flow
    const sceneDepth = viewportDepthTexture(screenUV, 0).x;
    const sceneView = getViewPosition(screenUV, sceneDepth, cameraProjectionMatrixInverse);
    const sceneLocal = modelWorldMatrixInverse.mul(cameraWorldMatrix.mul(vec4(sceneView, 1.0))).xyz;
    const sceneDistance = sceneLocal.sub(origin).dot(rayDirection);
    const bounds = hitUnitBox(origin, rayDirection).toVar();
    // NOTE Camera in the liquid: no surface, the ray goes straight to the scene or out of the liquid
    const underwater = bounds.x
      .lessThan(0.0)
      .and(sampleDensity(origin).greaterThanEqual(uniforms.level))
      .toVar();
    const end = min(bounds.y, sceneDistance).toVar();
    const distance = max(bounds.x, 0.0).toVar();
    const previous = distance.toVar();
    const hit = bool(false).toVar();
    const fineStep = texel * 0.75;
    // NOTE A zero direction component gives a large distance to the cell side, not a division by zero
    const safeDirection = rayDirection.add(step(rayDirection.abs(), vec3(1e-6)).mul(1e-6));

    Loop(512, () => {
      If(distance.greaterThan(end), () => {
        Break();
      });

      const position = origin.add(rayDirection.mul(distance));
      const coarse = texture3D(coarseTexture, position.add(0.5), 0).r;

      If(coarse.equal(0.0), () => {
        // NOTE Empty cell: go to the side where the ray leaves it
        const cell = position.add(0.5).mul(coarseSize).floor();
        const cellMin = cell.div(coarseSize).sub(0.5);
        const side = mix(cellMin, cellMin.add(1.0 / coarseSize), step(0.0, rayDirection));
        const exits = side.sub(position).div(safeDirection);

        previous.assign(distance);
        distance.addAssign(max(min(exits.x, min(exits.y, exits.z)), 0.0).add(1e-4));
      }).Else(() => {
        If(sampleDensity(position).greaterThanEqual(uniforms.level), () => {
          hit.assign(true);
          Break();
        });

        previous.assign(distance);
        distance.addAssign(fineStep);
      });
    });

    hit.not().discard();

    // NOTE The surface is between the last sample out of the liquid and the first sample in it
    const outside = previous.toVar();
    const inside = distance.toVar();

    Loop(6, () => {
      const middle = outside.add(inside).mul(0.5);
      const isInside = sampleDensity(origin.add(rayDirection.mul(middle))).greaterThanEqual(
        uniforms.level
      );

      inside.assign(select(isInside, middle, inside));
      outside.assign(select(isInside, outside, middle));
    });

    const surface = origin.add(rayDirection.mul(inside)).toVar();
    const surfaceWorld = modelWorldMatrix.mul(vec4(surface, 1.0)).xyz;
    // NOTE From the ray, not from the camera position: in the liquid, the surface point is the camera
    const view = rayDirection.mul(uniforms.boxSize).normalize().negate();
    const incident = view.negate();
    const normal = select(
      underwater,
      view,
      toWorldNormal(getNormal(surface, rayDirection.negate()))
    ).toVar();
    const cosine = normal.dot(view).clamp(0.0, 1.0);
    const reflectance = uniforms.ior.sub(1.0).div(uniforms.ior.add(1.0)).pow2();
    const fresnel = select(
      underwater,
      0.0,
      reflectance.add(reflectance.oneMinus().mul(cosine.oneMinus().pow(5.0)))
    );

    // NOTE Reflection: environment and a sharp sun highlight
    const reflected = reflect(incident, normal);
    const environmentNode = texture(getEnvironment(), equirectUV(reflected), 0);

    environmentNodes.push(environmentNode);

    const environment = environmentNode.rgb.mul(uniforms.environmentIntensity);
    const halfVector = uniforms.sunDirection.add(view).normalize();
    const highlight = normal
      .dot(halfVector)
      .clamp(0.0, 1.0)
      .pow(1000.0)
      .mul(40.0)
      .mul(normal.dot(uniforms.sunDirection).clamp(0.0, 1.0));
    const reflection = environment.mul(fresnel).add(uniforms.sunColor.mul(highlight).mul(fresnel));

    // NOTE Refraction: the bent ray goes through the liquid to its exit, or to the scene behind it
    const refracted = refract(incident, normal, uniforms.ior.reciprocal()).normalize();
    const insideDirection = toLocalDirection(refracted).toVar();
    const insideScale = insideDirection.mul(uniforms.boxSize).length();
    const insideEnd = min(hitUnitBox(surface, insideDirection).y, end.sub(inside));
    const travelled = float(texel).toVar();

    Loop(256, () => {
      If(
        travelled
          .greaterThan(insideEnd)
          .or(sampleDensity(surface.add(insideDirection.mul(travelled))).lessThan(uniforms.level)),
        () => {
          Break();
        }
      );

      travelled.addAssign(texel);
    });

    const thickness = travelled.min(insideEnd).max(0.0).mul(insideScale);
    const exitLocal = surface.add(insideDirection.mul(travelled.min(insideEnd)));
    const exitWorld = modelWorldMatrix.mul(vec4(exitLocal, 1.0)).xyz;
    // NOTE Out of the liquid: the second refraction. With total internal reflection, the ray does not bend.
    const exitNormal = toWorldNormal(getNormal(exitLocal, insideDirection));
    const bent = refract(refracted, exitNormal.negate(), uniforms.ior);
    const outDirection = select(bent.dot(bent).greaterThan(0.0), bent.normalize(), refracted);
    // NOTE With no scene object behind the liquid, the far plane gives a point far away, in the out direction
    const sceneWorldDistance = max(sceneDistance.sub(inside), 0.0).mul(
      rayDirection.mul(uniforms.boxSize).length()
    );
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
    // NOTE Murky liquid: light of the sky and the sun scattered in the liquid
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
  material.side = Three.BackSide;
  material.transparent = true;
  // NOTE The shader stops the ray at the scene depth. A depth test on the box sides removes liquid in front of objects in the box.
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;

  const mesh = new Three.Mesh(new Three.BoxGeometry(1.0, 1.0, 1.0), material);
  const sunPosition = new Three.Vector3();
  const targetPosition = new Three.Vector3();

  placeInBox(mesh, box);

  const view = {
    object: mesh,
    setDensity: (data, coarse) => {
      setTextureData(densityTexture, data);

      if (coarse) {
        setTextureData(coarseTexture, coarse);
      }
    },
    setParams: (params) => {
      uniforms.level.value = params.surfaceLevel;
      uniforms.ior.value = params.ior;
      uniforms.tint.value.set(params.color);
      uniforms.scatter.value = params.scatter;

      const { r, g, b } = uniforms.tint.value;
      const scale = params.absorbance / params.tintDistance;

      uniforms.absorption.value.set(
        ...[r, g, b].map((channel) => -Math.log(Math.max(channel, 1e-3)) * scale)
      );
    },
    update: () => {
      const [sun] = scene.getObjectsByProperty('isDirectionalLight', true);
      const [sky] = scene.getObjectsByProperty('isHemisphereLight', true);
      const environment = getEnvironment();

      environmentNodes.forEach((node) => {
        node.value = environment;
      });

      uniforms.environmentIntensity.value = scene.environment ? scene.environmentIntensity : 0.0;
      uniforms.sunColor.value.setScalar(0.0);
      uniforms.skyColor.value.setScalar(0.0);

      if (sun) {
        sun.getWorldPosition(sunPosition);
        sun.target.getWorldPosition(targetPosition);
        uniforms.sunDirection.value.subVectors(sunPosition, targetPosition).normalize();
        uniforms.sunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
      }

      if (sky) {
        uniforms.skyColor.value.copy(sky.color).multiplyScalar(sky.intensity);
      }
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

export const createVolumeView = (type, options) => {
  if (type === 'frame') {
    return createFrameView(options);
  }

  if (type === 'liquid' && !useWebGLRenderer) {
    return createLiquidView(options);
  }

  return useWebGLRenderer ? createShaderView(options) : createNodeView(options);
};
