import * as Three from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
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

// NOTE Liquid view (WebGL, GLSL). See volumeLiquid.js.
// NOTE WebGLRenderer gives custom materials no copy of the screen. The liquid reads a scene target.
// NOTE This view draws the frame: the scene to the target, the target to the screen, then the liquid.

const toGlslFloat = (value) => (Number.isInteger(value) ? value.toFixed(1) : `${value}`);

const vertexShader = /* glsl */ `
  uniform mat4 worldToLocal;

  out vec3 vOrigin;
  out vec3 vDirection;

  void main() {
    vOrigin = (worldToLocal * vec4(cameraPosition, 1.0)).xyz;
    vDirection = position - vOrigin;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// NOTE Textures are read with a level: after the discard, the control flow is not uniform
const fragmentShader = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  uniform sampler3D densityMap;
  uniform sampler3D coarseMap;
  uniform sampler2D sceneColorMap;
  uniform sampler2D sceneDepthMap;
  uniform samplerCube environmentMap;
  uniform mat3 environmentRotation;
  uniform float environmentMaxMip;
  uniform float environmentIntensity;
  uniform mat4 localToWorld;
  uniform mat4 worldToLocal;
  uniform mat4 cameraWorld;
  uniform mat4 cameraView;
  uniform mat4 cameraProjection;
  uniform mat4 cameraProjectionInverse;
  uniform vec2 screenSize;
  uniform float level;
  uniform float ior;
  uniform vec3 absorption;
  uniform vec3 tint;
  uniform float scatter;
  uniform vec3 sunDirection;
  uniform vec3 sunColor;
  uniform vec3 skyColor;

  in vec3 vOrigin;
  in vec3 vDirection;

  // NOTE A zero component gives a very large distance to a box side, not a division by zero
  vec3 toNonZero(vec3 direction) {
    return direction + step(abs(direction), vec3(1e-6)) * 1e-6;
  }

  // NOTE Box of size 1 at the origin, in local space. Distances to the entry and the exit of the ray.
  vec2 hitUnitBox(vec3 origin, vec3 direction) {
    vec3 inverseDirection = 1.0 / toNonZero(direction);
    vec3 near = (vec3(-0.5) - origin) * inverseDirection;
    vec3 far = (vec3(0.5) - origin) * inverseDirection;
    vec3 entry = min(near, far);
    vec3 exit = max(near, far);

    return vec2(max(max(entry.x, entry.y), entry.z), min(min(exit.x, exit.y), exit.z));
  }

  float sampleDensity(vec3 position) {
    return textureLod(densityMap, position + 0.5, 0.0).r;
  }

  bool isInLiquid(vec3 position) {
    return sampleDensity(position) >= level;
  }

  // NOTE Outward normal in local space: the density goes up into the liquid. "fallback" where the density is flat.
  vec3 getNormal(vec3 position, vec3 fallback) {
    float offset = TEXEL * GRADIENT_OFFSET;
    vec3 gradient = vec3(
      sampleDensity(position - vec3(offset, 0.0, 0.0)) - sampleDensity(position + vec3(offset, 0.0, 0.0)),
      sampleDensity(position - vec3(0.0, offset, 0.0)) - sampleDensity(position + vec3(0.0, offset, 0.0)),
      sampleDensity(position - vec3(0.0, 0.0, offset)) - sampleDensity(position + vec3(0.0, 0.0, offset))
    );

    return dot(gradient, gradient) > 1e-10 ? normalize(gradient) : fallback;
  }

  // NOTE Schlick approximation of the Fresnel reflectance
  float getFresnel(float reflectance, float cosine) {
    return reflectance + (1.0 - reflectance) * pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
  }

  vec3 toWorldDirection(vec3 direction) {
    return (localToWorld * vec4(direction, 0.0)).xyz;
  }

  vec3 toLocalDirection(vec3 direction) {
    return normalize((worldToLocal * vec4(direction, 0.0)).xyz);
  }

  // NOTE Normals use the inverse transpose of the model matrix
  vec3 toWorldNormal(vec3 normal) {
    return normalize((transpose(worldToLocal) * vec4(normal, 0.0)).xyz);
  }

  // NOTE WebGL clip space: depth from -1 to 1
  vec3 getViewPosition(vec2 uv, float depth) {
    vec4 view = cameraProjectionInverse * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);

    return view.xyz / view.w;
  }

  vec2 getScreenUV(vec3 world) {
    vec4 clip = cameraProjection * cameraView * vec4(world, 1.0);

    return clip.xy / clip.w * 0.5 + 0.5;
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / screenSize;
    vec3 rayDirection = normalize(vDirection);
    // NOTE World units for one local unit on the view ray
    float rayScale = length(toWorldDirection(rayDirection));

    vec3 sceneView = getViewPosition(uv, textureLod(sceneDepthMap, uv, 0.0).x);
    vec3 sceneLocal = (worldToLocal * cameraWorld * vec4(sceneView, 1.0)).xyz;
    float sceneDistance = dot(sceneLocal - vOrigin, rayDirection);
    vec2 bounds = hitUnitBox(vOrigin, rayDirection);
    float end = min(bounds.y, sceneDistance);
    // NOTE Camera in the liquid: no surface. The ray goes straight to the scene or out of the liquid.
    bool underwater = bounds.x < 0.0 && isInLiquid(vOrigin);

    // NOTE March to the surface. Empty coarse cells are skipped.
    float rayDistance = max(bounds.x, 0.0);
    float previous = rayDistance;
    bool hit = false;
    vec3 cellDirection = toNonZero(rayDirection);

    for (int i = 0; i < SURFACE_STEPS; i++) {
      if (rayDistance > end) {
        break;
      }

      vec3 position = vOrigin + rayDirection * rayDistance;

      if (textureLod(coarseMap, position + 0.5, 0.0).r == 0.0) {
        vec3 cellMin = floor((position + 0.5) * COARSE_SIZE) / COARSE_SIZE - 0.5;
        vec3 cellSide = mix(cellMin, cellMin + 1.0 / COARSE_SIZE, step(0.0, rayDirection));
        vec3 exits = (cellSide - position) / cellDirection;

        previous = rayDistance;
        rayDistance += max(min(min(exits.x, exits.y), exits.z), 0.0) + 1e-4;
      } else {
        if (isInLiquid(position)) {
          hit = true;
          break;
        }

        previous = rayDistance;
        rayDistance += TEXEL * SURFACE_STEP;
      }
    }

    if (!hit) {
      discard;
    }

    // NOTE The surface is between the last sample out of the liquid and the first sample in it
    float outside = previous;
    float inside = rayDistance;

    for (int i = 0; i < REFINE_STEPS; i++) {
      float middle = (outside + inside) * 0.5;

      if (isInLiquid(vOrigin + rayDirection * middle)) {
        inside = middle;
      } else {
        outside = middle;
      }
    }

    vec3 surface = vOrigin + rayDirection * inside;
    vec3 surfaceWorld = (localToWorld * vec4(surface, 1.0)).xyz;
    // NOTE From the ray, not from the camera position: in the liquid, the surface point is the camera
    vec3 view = -normalize(toWorldDirection(rayDirection));
    vec3 incident = -view;
    vec3 normal = underwater ? view : toWorldNormal(getNormal(surface, -rayDirection));
    float reflectance = (ior - 1.0) / (ior + 1.0);

    reflectance *= reflectance;

    float surfaceWeight = underwater ? 0.0 : 1.0;
    float fresnel = getFresnel(reflectance, dot(normal, view)) * surfaceWeight;

    // NOTE Reflection: PMREM environment (mip of the roughness, as three.js) and a normalized Blinn-Phong sun highlight
    float roughness = SURFACE_ROUGHNESS;
    float environmentMip = environmentMaxMip * roughness * (2.0 - roughness);
    vec3 environment = textureLod(environmentMap, environmentRotation * reflect(incident, normal), environmentMip).rgb;
    vec3 halfVector = normalize(sunDirection + view);
    float highlight = pow(clamp(dot(normal, halfVector), 0.0, 1.0), HIGHLIGHT_SHININESS) * HIGHLIGHT_SCALE
      * clamp(dot(normal, sunDirection), 0.0, 1.0) * getFresnel(reflectance, dot(view, halfVector)) * surfaceWeight;
    vec3 reflection = environment * environmentIntensity * fresnel + sunColor * highlight;

    // NOTE Refraction: the bent ray goes through the liquid to its exit. Objects in the liquid stop it at the
    // scene distance of the view ray.
    vec3 refracted = normalize(refract(incident, normal, 1.0 / ior));
    vec3 insideDirection = toLocalDirection(refracted);
    float insideEnd = min(hitUnitBox(surface, insideDirection).y, end - inside);
    float travelled = TEXEL;

    for (int i = 0; i < INSIDE_STEPS; i++) {
      if (travelled > insideEnd || !isInLiquid(surface + insideDirection * travelled)) {
        break;
      }

      travelled += TEXEL;
    }

    float insideLength = max(min(travelled, insideEnd), 0.0);
    float thickness = insideLength * length(toWorldDirection(insideDirection));
    vec3 exitLocal = surface + insideDirection * insideLength;
    vec3 exitWorld = (localToWorld * vec4(exitLocal, 1.0)).xyz;
    // NOTE Out of the liquid: the second refraction. With total internal reflection, the ray does not bend.
    vec3 exitNormal = toWorldNormal(getNormal(exitLocal, insideDirection));
    vec3 bent = refract(refracted, -exitNormal, ior);
    vec3 outDirection = dot(bent, bent) > 0.0 ? normalize(bent) : refracted;
    // NOTE With no scene object behind the liquid, the far plane gives a point far away in the out direction
    float sceneWorldDistance = max(sceneDistance - inside, 0.0) * rayScale;
    vec3 behind = exitWorld + outDirection * max(sceneWorldDistance - thickness, 0.01);
    vec2 refractedUV = clamp(getScreenUV(behind), 0.0, 1.0);
    // NOTE A scene object in front of the surface must not show through the liquid
    float surfaceViewZ = (cameraView * vec4(surfaceWorld, 1.0)).z;
    float behindViewZ = getViewPosition(refractedUV, textureLod(sceneDepthMap, refractedUV, 0.0).x).z;
    vec2 backdropUV = behindViewZ > surfaceViewZ ? uv : refractedUV;
    vec3 backdrop = textureLod(sceneColorMap, backdropUV, 0.0).rgb;
    vec3 transmittance = exp(-absorption * thickness);
    // NOTE Murky liquid: sky and sun light scattered in the liquid
    vec3 scattered = (1.0 - transmittance) * tint * scatter
      * (skyColor + sunColor * clamp(dot(normal, sunDirection), 0.0, 1.0));
    vec3 transmitted = (backdrop * transmittance + scattered) * (1.0 - fresnel);

    gl_FragColor = vec4(reflection + transmitted, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// NOTE The scene target is linear. Tone mapping and the output color space apply when it goes to the screen.
const createCompositeMaterial = () =>
  new Three.ShaderMaterial({
    uniforms: { map: { value: null } },
    vertexShader: /* glsl */ `
      out vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;

      in vec2 vUv;

      void main() {
        gl_FragColor = vec4(textureLod(map, vUv, 0.0).rgb, 1.0);

        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    depthTest: false,
    depthWrite: false,
  });

const rotationMatrix = new Three.Matrix4();

// NOTE "context": scene, camera, renderer and setRenderFrame of the examples
export const createLiquidWebGLView = ({
  resolution,
  bbox,
  params,
  scene,
  camera,
  renderer,
  setRenderFrame,
}) => {
  const { texel, coarseSize, densityTexture, coarseTexture, surfaceSteps, insideSteps } =
    createLiquidGrids(resolution);
  const box = toBox(bbox);
  const boxMatrix = new Three.Matrix4().compose(
    box.getCenter(new Three.Vector3()),
    new Three.Quaternion(),
    box.getSize(new Three.Vector3())
  );
  // NOTE Linear color and depth of the scene without the liquid. Same samples as the canvas antialias.
  const sceneTarget = new Three.WebGLRenderTarget(1, 1, {
    type: Three.HalfFloatType,
    samples: 4,
    depthTexture: new Three.DepthTexture(1, 1),
  });
  const composite = new FullScreenQuad(createCompositeMaterial());
  const drawingSize = new Three.Vector2();
  let pmremGenerator = null;
  let environmentTarget = null;
  // NOTE The scene environment of environmentTarget. A new environment makes the PMREM again.
  let environmentSource = null;

  const material = new Three.ShaderMaterial({
    defines: {
      SURFACE_STEPS: surfaceSteps,
      INSIDE_STEPS: insideSteps,
      REFINE_STEPS: refineSteps,
      COARSE_SIZE: toGlslFloat(coarseSize),
      TEXEL: toGlslFloat(texel),
      SURFACE_STEP: toGlslFloat(surfaceStep),
      GRADIENT_OFFSET: toGlslFloat(gradientOffset),
      SURFACE_ROUGHNESS: toGlslFloat(surfaceRoughness),
      HIGHLIGHT_SHININESS: toGlslFloat(highlightShininess),
      HIGHLIGHT_SCALE: toGlslFloat(highlightScale),
    },
    uniforms: {
      densityMap: { value: densityTexture },
      coarseMap: { value: coarseTexture },
      sceneColorMap: { value: sceneTarget.texture },
      sceneDepthMap: { value: sceneTarget.depthTexture },
      // NOTE null: WebGLRenderer uses an empty cube texture
      environmentMap: { value: null },
      environmentRotation: { value: new Three.Matrix3() },
      environmentMaxMip: { value: 0.0 },
      environmentIntensity: { value: 0.0 },
      localToWorld: { value: new Three.Matrix4() },
      worldToLocal: { value: new Three.Matrix4() },
      cameraWorld: { value: new Three.Matrix4() },
      cameraView: { value: new Three.Matrix4() },
      cameraProjection: { value: new Three.Matrix4() },
      cameraProjectionInverse: { value: new Three.Matrix4() },
      screenSize: { value: new Three.Vector2() },
      level: { value: 0.5 },
      ior: { value: 1.333 },
      absorption: { value: new Three.Vector3() },
      tint: { value: new Three.Color() },
      scatter: { value: 0.0 },
      sunDirection: { value: new Three.Vector3(0.0, 1.0, 0.0) },
      sunColor: { value: new Three.Color() },
      skyColor: { value: new Three.Color() },
    },
    vertexShader,
    fragmentShader,
    // NOTE Back faces: the box also shows when the camera is in it
    side: Three.BackSide,
    // NOTE The shader stops the ray at the scene depth
    depthTest: false,
    depthWrite: false,
  });
  const { uniforms } = material;
  // NOTE The liquid has its own scene. It is drawn after the scene target is on the screen.
  const liquidScene = new Three.Scene();
  const mesh = new Three.Mesh(new Three.BoxGeometry(1.0, 1.0, 1.0), material);
  // NOTE The place of the view in the main scene. The mesh follows its world matrix.
  const anchor = new Three.Group();

  mesh.matrixAutoUpdate = false;
  liquidScene.add(mesh);

  // NOTE Cube textures and equirect textures. The PMREM is a render target texture: the rotation has no flip.
  const updateEnvironment = () => {
    const environment = scene.environment?.isTexture ? scene.environment : null;

    if (environment !== environmentSource) {
      environmentSource = environment;
      environmentTarget?.dispose();
      environmentTarget = null;

      if (environment) {
        pmremGenerator ??= new Three.PMREMGenerator(renderer);
        environmentTarget = environment.isCubeTexture
          ? pmremGenerator.fromCubemap(environment)
          : pmremGenerator.fromEquirectangular(environment);
      }

      uniforms.environmentMap.value = environmentTarget?.texture ?? null;
      uniforms.environmentMaxMip.value = environmentTarget
        ? environmentTarget.texture.mipmaps.length - 1
        : 0.0;
    }

    uniforms.environmentIntensity.value = environment ? scene.environmentIntensity : 0.0;
    uniforms.environmentRotation.value
      .setFromMatrix4(rotationMatrix.makeRotationFromEuler(scene.environmentRotation))
      .transpose();
  };

  const renderFrame = () => {
    renderer.getDrawingBufferSize(drawingSize);
    sceneTarget.setSize(drawingSize.x, drawingSize.y);
    updateEnvironment();

    renderer.setRenderTarget(sceneTarget);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);

    composite.material.uniforms.map.value = sceneTarget.texture;
    composite.render(renderer);

    // NOTE The scene render made the world matrices of the anchor and the camera
    mesh.matrix.multiplyMatrices(anchor.matrixWorld, boxMatrix);
    uniforms.localToWorld.value.copy(mesh.matrix);
    uniforms.worldToLocal.value.copy(mesh.matrix).invert();
    uniforms.cameraWorld.value.copy(camera.matrixWorld);
    uniforms.cameraView.value.copy(camera.matrixWorldInverse);
    uniforms.cameraProjection.value.copy(camera.projectionMatrix);
    uniforms.cameraProjectionInverse.value.copy(camera.projectionMatrixInverse);
    uniforms.screenSize.value.copy(drawingSize);

    const { autoClear } = renderer;

    renderer.autoClear = false;
    renderer.render(liquidScene, camera);
    renderer.autoClear = autoClear;
  };

  setRenderFrame(renderFrame);

  const view = {
    object: anchor,
    setDensity: (data, coarse) => {
      setTextureData(densityTexture, data);
      setTextureData(coarseTexture, coarse);
    },
    setParams: (params) => {
      uniforms.level.value = params.surfaceLevel;
      uniforms.ior.value = params.ior;
      uniforms.scatter.value = params.scatter;
      uniforms.tint.value.set(params.color);
      setLiquidAbsorption(uniforms.absorption.value, uniforms.tint.value, params.tintDistance);
    },
    update: () => {
      readSceneLights(scene, {
        sunDirection: uniforms.sunDirection.value,
        sunColor: uniforms.sunColor.value,
        skyColor: uniforms.skyColor.value,
      });
    },
    dispose: () => {
      setRenderFrame(null);
      anchor.removeFromParent();
      mesh.geometry.dispose();
      material.dispose();
      composite.material.dispose();
      composite.dispose();
      sceneTarget.depthTexture.dispose();
      sceneTarget.dispose();
      environmentTarget?.dispose();
      pmremGenerator?.dispose();
      densityTexture.dispose();
      coarseTexture.dispose();
    },
  };

  view.setParams(params);

  return view;
};
