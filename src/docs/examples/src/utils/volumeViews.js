import * as Three from 'three';
import { RenderPipeline, VolumeNodeMaterial } from 'three/webgpu';
import {
  Fn,
  modelWorldMatrixInverse,
  pass,
  screenCoordinate,
  screenUV,
  step,
  texture3D,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { bayer16 } from 'three/examples/jsm/tsl/math/Bayer.js';
import { FrameVolume } from 'three-openvdb';

// NOTE Views of one density grid (resolution^3 bytes) in a world box. "frame": FrameVolume of three-openvdb.
// "builtin": three.js only.

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

export const createVolumeView = (type, options) => {
  if (type === 'frame') {
    return createFrameView(options);
  }

  return useWebGLRenderer ? createShaderView(options) : createNodeView(options);
};
