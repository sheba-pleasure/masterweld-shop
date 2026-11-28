import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

export interface WorkshopController {
  setPaused: (paused: boolean) => void;
  dispose: () => void;
}

interface SceneOptions {
  logo: string;
  onReady: () => void;
  onFailure: () => void;
}

// One owner, one scheduler. Nothing in this module is imported during SSR.
export function mountWorkshopScene(host: HTMLElement, options: SceneOptions): WorkshopController {
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "low-power",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;
  const canvas = renderer.domElement;
  canvas.className = "workshop-canvas";
  canvas.setAttribute("aria-hidden", "true");
  host.appendChild(canvas);
  const owned: Array<{ dispose: () => void }> = [];
  const own = <T extends { dispose: () => void }>(resource: T): T => {
    owned.push(resource);
    return resource;
  };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 60);
  camera.position.set(0, 0, 12);
  const envScene = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = own(pmrem.fromScene(envScene, 0.08));
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.7;
  envScene.dispose();
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xe4eeff, 0x38251b, 2.2));
  const windowLight = new THREE.DirectionalLight(0xf2f5ff, 3.5);
  windowLight.position.set(-5, 8, 9);
  scene.add(windowLight);
  const warmLight = new THREE.DirectionalLight(0xffb566, 1.8);
  warmLight.position.set(7, -2, 4);
  scene.add(warmLight);
  const arcLight = new THREE.PointLight(0x9ccfff, 16, 12, 2);
  scene.add(arcLight);

  const sign = new THREE.Group();
  scene.add(sign);
  const oval = new THREE.Shape();
  oval.absellipse(0, 0, 2.68, 1.46, 0, Math.PI * 2, false, 0);
  const backGeometry = own(
    new THREE.ExtrudeGeometry(oval, {
      depth: 0.18,
      steps: 1,
      bevelEnabled: true,
      bevelSegments: 4,
      bevelSize: 0.065,
      bevelThickness: 0.06,
      curveSegments: 72,
    }),
  );
  const chrome = own(
    new THREE.MeshPhysicalMaterial({
      color: 0x777d7e,
      metalness: 0.95,
      roughness: 0.34,
      clearcoat: 0.8,
    }),
  );
  sign.add(new THREE.Mesh(backGeometry, chrome));
  const faceGeometry = own(new THREE.PlaneGeometry(5.5, 3.03));
  const faceMaterial = own(
    new THREE.MeshBasicMaterial({
      transparent: true,
      alphaTest: 0.02,
      toneMapped: false,
    }),
  );
  const face = new THREE.Mesh(faceGeometry, faceMaterial);
  face.position.z = 0.257;
  sign.add(face);
  const standMaterial = own(
    new THREE.MeshStandardMaterial({ color: 0x202729, metalness: 0.85, roughness: 0.48 }),
  );
  const supportGeometry = own(new THREE.CylinderGeometry(0.035, 0.055, 1.35, 10));
  for (const x of [-1.75, 1.75]) {
    const support = new THREE.Mesh(supportGeometry, standMaterial);
    support.position.set(x, -1.75, -0.025);
    sign.add(support);
  }
  const base = new THREE.Mesh(own(new THREE.BoxGeometry(4.6, 0.09, 0.7)), standMaterial);
  base.position.set(0, -2.42, 0);
  sign.add(base);
  const footShadow = new THREE.Mesh(
    own(new THREE.PlaneGeometry(5.7, 1.9)),
    own(
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
        fragmentShader: `varying vec2 vUv;void main(){vec2 p=(vUv-.5)*2.;float a=exp(-dot(p,p)*3.)*.5;gl_FragColor=vec4(0.,0.,0.,a);}`,
      }),
    ),
  );
  footShadow.rotation.x = -Math.PI / 2;
  footShadow.position.set(0, -2.475, 0.08);
  sign.add(footShadow);

  // A small shaped reflection crosses the actual original logo texture, not replacement lettering.
  const sheenMaterial = own(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uStrength: { value: 0.035 } },
      vertexShader: `varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `varying vec2 vUv;uniform float uTime;uniform float uStrength;
      void main(){vec2 p=(vUv-.5)*2.;float oval=1.-smoothstep(.91,1.,dot(p,p));
      float line=exp(-pow((vUv.x+vUv.y*.27-(.42+.22*sin(uTime*.18)))*10.,2.));
      gl_FragColor=vec4(.9,.95,1.,line*oval*uStrength);}`,
    }),
  );
  const sheen = new THREE.Mesh(faceGeometry, sheenMaterial);
  sheen.position.z = 0.263;
  sign.add(sheen);

  const glowCanvas = document.createElement("canvas");
  glowCanvas.width = glowCanvas.height = 128;
  const context = glowCanvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.08, "rgba(220,239,255,0.95)");
    gradient.addColorStop(0.22, "rgba(113,183,255,0.4)");
    gradient.addColorStop(1, "rgba(63,121,230,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
  }
  const glowTexture = own(new THREE.CanvasTexture(glowCanvas));
  const arcMaterial = own(
    new THREE.SpriteMaterial({
      map: glowTexture,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.75,
      toneMapped: false,
    }),
  );
  const arc = new THREE.Sprite(arcMaterial);
  scene.add(arc);

  const particles = 110;
  const positions = new Float32Array(particles * 6);
  const colors = new Float32Array(particles * 6);
  const pointPositions = new Float32Array(particles * 3);
  const pointColors = new Float32Array(particles * 3);
  const geometry = own(new THREE.BufferGeometry());
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage),
  );
  const trails = new THREE.LineSegments(
    geometry,
    own(
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.88,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    ),
  );
  trails.frustumCulled = false;
  scene.add(trails);
  const pointGeometry = own(new THREE.BufferGeometry());
  pointGeometry.setAttribute(
    "position",
    new THREE.BufferAttribute(pointPositions, 3).setUsage(THREE.DynamicDrawUsage),
  );
  pointGeometry.setAttribute(
    "color",
    new THREE.BufferAttribute(pointColors, 3).setUsage(THREE.DynamicDrawUsage),
  );
  const points = new THREE.Points(
    pointGeometry,
    own(
      new THREE.ShaderMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexColors: true,
        toneMapped: false,
        vertexShader: `varying vec3 vColor;void main(){vColor=color;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=clamp(27./-p.z,1.,4.);}`,
        fragmentShader: `varying vec3 vColor;void main(){float r=length(gl_PointCoord-.5)*2.;float a=pow(max(0.,1.-r),2.);gl_FragColor=vec4(vColor,a);}`,
      }),
    ),
  );
  points.frustumCulled = false;
  scene.add(points);
  const seeds = Array.from({ length: particles }, (_, i) => {
    const a = Math.sin(i * 127.1 + 71.7) * 43758.5453;
    const b = Math.sin(i * 269.5 + 43.1) * 12713.491;
    const c = Math.sin(i * 83.1 + 19.3) * 47127.113;
    return { a: a - Math.floor(a), b: b - Math.floor(b), c: c - Math.floor(c) };
  });

  const smokeMaterial = own(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
      fragmentShader: `varying vec2 vUv;uniform float uTime;
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
      void main(){vec2 p=vUv;float n=0.,a=.5;vec2 q=p*5.-vec2(uTime*.06,uTime*.15);
      for(int i=0;i<4;i++){n+=noise(q)*a;q=q*2.03+4.1;a*=.5;}
      float envelope=exp(-pow((p.x-.45-(p.y*.13))*(4.5-p.y*2.),2.))*smoothstep(0.,.25,p.y)*(1.-p.y);
      float alpha=smoothstep(.35,.8,n)*envelope*.12;
      gl_FragColor=vec4(.59,.66,.71,alpha);}`,
    }),
  );
  const smoke = new THREE.Mesh(own(new THREE.PlaneGeometry(2.7, 3.7)), smokeMaterial);
  smoke.renderOrder = 2;
  scene.add(smoke);

  let disposed = false;
  let loaded = false;
  let paused = false;
  let visible = true;
  let lost = false;
  let raf = 0;
  let elapsed = 0;
  let last = 0;
  let lastDraw = 0;
  let mobile = false;
  let worldHeight = 1;
  let worldWidth = 1;
  let pixelRatio = 1;
  let slowFrames = 0;
  let downgraded = false;
  let targetX = 0;
  let targetY = 0;
  const weld = new THREE.Vector3();

  const resize = () => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height || disposed) return;
    mobile = width < 760;
    pixelRatio = Math.min(window.devicePixelRatio || 1, mobile ? 1.25 : 1.5);
    renderer.setPixelRatio(downgraded ? 1 : pixelRatio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    worldHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 12;
    worldWidth = worldHeight * camera.aspect;
    const logoWidth = worldWidth * (mobile ? 0.8 : 0.345);
    sign.scale.setScalar(logoWidth / 5.5);
    sign.position.set(
      worldWidth * (mobile ? -0.035 : 0.15),
      worldHeight * (mobile ? 0.115 : 0.06),
      0,
    );
    sign.rotation.set(0.018, -0.04, -0.012);
    // Locate the photographed contact point after object-fit:cover and art-directed cropping.
    const factor = Math.max(width / 1983, height / 795);
    const offsetX = (width - 1983 * factor) * (mobile ? 0.8 : 0.5);
    const offsetY = (height - 795 * factor) * 0.5;
    const x = (1608 * factor + offsetX) / width;
    const y = (536 * factor + offsetY) / height;
    weld.set((x - 0.5) * worldWidth, (0.5 - y) * worldHeight, 0.15);
    arc.position.copy(weld);
    arc.scale.setScalar(worldHeight * 0.055);
    arcLight.position.copy(weld).add(new THREE.Vector3(-0.12, 0.1, 0.8));
    smoke.position.set(weld.x - 0.25, weld.y + 1.25, -0.2);
    smoke.visible = !mobile && !downgraded;
    geometry.setDrawRange(0, (mobile || downgraded ? 54 : particles) * 2);
    pointGeometry.setDrawRange(0, mobile || downgraded ? 54 : particles);
    if (loaded) draw(0);
  };

  const sparkPosition = (
    age: number,
    seed: { a: number; b: number; c: number },
    target: Float32Array,
    offset: number,
  ) => {
    const velocityX = (seed.a - 0.66) * 4.3;
    const velocityY = 0.1 + seed.b * 3.3;
    const velocityZ = (seed.c - 0.35) * 3.2;
    const gravity = 9.5;
    const floor = -0.55;
    const hit = (velocityY + Math.sqrt(velocityY * velocityY - 2 * gravity * floor)) / gravity;
    let y = velocityY * age - 0.5 * gravity * age * age;
    if (age > hit) {
      const after = age - hit;
      y = floor + (gravity * hit - velocityY) * 0.25 * after - 0.5 * gravity * after * after;
    }
    target[offset] = weld.x + velocityX * age;
    target[offset + 1] = weld.y + y;
    target[offset + 2] = weld.z + velocityZ * age;
  };

  const draw = (delta: number) => {
    elapsed += delta;
    const time = elapsed;
    camera.position.x += (targetX - camera.position.x) * Math.min(1, delta * 4);
    camera.position.y += (targetY - camera.position.y) * Math.min(1, delta * 4);
    camera.lookAt(0, 0, 0);
    const pulse = 0.94 + Math.sin(time * 8.7) * 0.025 + Math.sin(time * 17.3) * 0.018;
    arcMaterial.opacity = pulse * 0.74;
    arcLight.intensity = pulse * 16;
    sheenMaterial.uniforms["uTime"]!.value = time;
    smokeMaterial.uniforms["uTime"]!.value = time;
    for (let i = 0; i < particles; i++) {
      const seed = seeds[i]!;
      const life = 0.42 + seed.c * 0.65;
      const age = (time + seed.a * 3.1) % life;
      sparkPosition(age, seed, positions, i * 6);
      sparkPosition(Math.max(0, age - 0.014 - seed.a * 0.012), seed, positions, i * 6 + 3);
      pointPositions[i * 3] = positions[i * 6]!;
      pointPositions[i * 3 + 1] = positions[i * 6 + 1]!;
      pointPositions[i * 3 + 2] = positions[i * 6 + 2]!;
      const heat = Math.pow(1 - age / life, 0.45);
      const r = heat * 1.6,
        g = heat * (0.5 + heat * 0.45),
        b = heat * heat * 0.23;
      for (let j = 0; j < 2; j++) {
        const factor = j === 0 ? 1 : 0.2;
        colors[i * 6 + j * 3] = r * factor;
        colors[i * 6 + j * 3 + 1] = g * factor;
        colors[i * 6 + j * 3 + 2] = b * factor;
      }
      pointColors[i * 3] = r;
      pointColors[i * 3 + 1] = g;
      pointColors[i * 3 + 2] = b;
    }
    for (const attribute of [
      geometry.attributes["position"],
      geometry.attributes["color"],
      pointGeometry.attributes["position"],
      pointGeometry.attributes["color"],
    ])
      attribute!.needsUpdate = true;
    renderer.render(scene, camera);
    host.dataset["frames"] = String(renderer.info.render.frame);
  };

  const tick = (now: number) => {
    raf = 0;
    if (disposed || paused || !visible || document.hidden || lost || !loaded) return;
    const frameTime = last ? now - last : 16;
    last = now;
    if (frameTime > 38 && frameTime < 200) slowFrames++;
    if (slowFrames > 90 && !downgraded) {
      downgraded = true;
      resize();
    }
    if (!mobile || now - lastDraw > 31) {
      const delta = lastDraw ? Math.min((now - lastDraw) / 1000, 0.05) : 0;
      lastDraw = now;
      draw(delta);
    }
    raf = requestAnimationFrame(tick);
  };
  const schedule = () => {
    if (!raf && !disposed && !paused && visible && !document.hidden && !lost && loaded) {
      last = lastDraw = 0;
      raf = requestAnimationFrame(tick);
    }
  };
  const suspend = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    last = lastDraw = 0;
  };
  const pageVisibility = () => {
    if (document.hidden) suspend();
    else schedule();
  };
  const pointer = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" || mobile) return;
    const bounds = host.getBoundingClientRect();
    targetX = ((event.clientX - bounds.left) / bounds.width - 0.5) * 0.16;
    targetY = -((event.clientY - bounds.top) / bounds.height - 0.5) * 0.08;
  };
  const leave = () => {
    targetX = targetY = 0;
  };
  const contextLoss = (event: Event) => {
    event.preventDefault();
    lost = true;
    suspend();
    options.onFailure();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  const intersection = new IntersectionObserver(
    (entries) => {
      visible = entries[0]?.isIntersecting ?? false;
      if (visible) schedule();
      else suspend();
    },
    { threshold: 0.03 },
  );
  intersection.observe(host);
  host.parentElement?.addEventListener("pointermove", pointer);
  host.parentElement?.addEventListener("pointerleave", leave);
  document.addEventListener("visibilitychange", pageVisibility);
  canvas.addEventListener("webglcontextlost", contextLoss);
  resize();
  new THREE.TextureLoader().load(
    options.logo,
    (texture) => {
      if (disposed) {
        texture.dispose();
        return;
      }
      own(texture);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
      faceMaterial.map = texture;
      faceMaterial.needsUpdate = true;
      loaded = true;
      draw(0);
      options.onReady();
      schedule();
    },
    undefined,
    () => {
      if (!disposed) {
        lost = true;
        options.onFailure();
      }
    },
  );

  return {
    setPaused(value) {
      paused = value;
      if (paused) suspend();
      else schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      suspend();
      resizeObserver.disconnect();
      intersection.disconnect();
      host.parentElement?.removeEventListener("pointermove", pointer);
      host.parentElement?.removeEventListener("pointerleave", leave);
      document.removeEventListener("visibilitychange", pageVisibility);
      canvas.removeEventListener("webglcontextlost", contextLoss);
      for (const resource of owned) resource.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      delete host.dataset["frames"];
    },
  };
}
