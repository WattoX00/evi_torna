import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import regions from '../data/regions.json';
import type { PresentationStep } from '../types';
import { loadPresentation, savePresentation } from '../data/db';
import { button, element, showMessage } from '../ui/dom';

type RegionName = keyof typeof regions;
type LayerName = 'bone' | 'muscle';
interface Part extends THREE.Mesh {
  userData: THREE.Mesh['userData'] & { layer?: LayerName; side?: 'left' | 'right' };
}

const REGION_NAMES = ['Full body', ...Object.keys(regions)] as const;
const PALETTE: Record<LayerName, number> = { muscle: 0xb95758, bone: 0xe9d8b8 };

export function renderAnatomyTab(): HTMLElement {
  const section = element('section', { className: 'tab-panel anatomy-panel', attrs: { id: 'tab-anatomy', 'aria-label': 'Anatomy' } });
  const header = element('div', { className: 'section-heading anatomy-heading' });
  header.append(element('div', { text: '' }));
  const title = element('div');
  title.append(element('h1', { text: 'Anatomy' }), element('p', { text: 'Explore muscles and bones' }));
  header.replaceChildren(title);

  const workspace = element('div', { className: 'anatomy-workspace' });
  const controls = element('aside', { className: 'anatomy-controls', attrs: { 'aria-label': 'Anatomy controls' } });
  const viewport = element('div', { className: 'anatomy-viewport' });
  const canvas = element('canvas', { attrs: { 'aria-label': 'Interactive 3D anatomy model', role: 'img' } });
  const progress = element('progress', { className: 'model-progress', attrs: { max: '100', value: '0', 'aria-label': 'Model loading progress' } });
  const hint = element('div', { className: 'viewer-hint', text: 'Drag to rotate · Pinch to zoom · Two-finger drag to pan · Double-tap to reset' });
  const selectionCard = element('div', { className: 'part-card', attrs: { id: 'part-card' } });
  viewport.append(canvas, progress, hint, selectionCard);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(800, 600, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0xf1f4f6);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf1f4f6);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x74808a, 2.1));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  keyLight.position.set(4, 7, 8);
  scene.add(keyLight);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
  camera.position.set(0, 1.2, 7);
  const controls3d = new OrbitControls(camera, canvas);
  controls3d.enableDamping = true;
  controls3d.dampingFactor = 0.08;
  controls3d.target.set(0, 1, 0);
  controls3d.minDistance = 2;
  controls3d.maxDistance = 12;
  const model = new THREE.Group();
  scene.add(model);
  const parts: Part[] = [];
  const regionSelect = element('select', { attrs: { 'aria-label': 'Select anatomy region' } });
  const search = element('input', { className: 'search-input', attrs: { type: 'search', placeholder: 'Find a part', 'aria-label': 'Search anatomy parts' } });
  const partList = element('div', { className: 'part-list', attrs: { role: 'listbox', 'aria-label': 'Anatomy parts' } });
  let selectedPart: Part | undefined;
  let currentRegion = 'Full body';
  let isolation: 'hide' | 'ghost' = 'hide';
  let scaleFactor = 1;
  let normalizedScale = 1;
  let animationTarget: { position: THREE.Vector3; target: THREE.Vector3 } | undefined;
  let frame = 0;
  let visible = true;
  let steps: PresentationStep[] = [];
  let stepIndex = -1;

  const resize = () => {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(viewport);

  const defaultMaterial = (layer: LayerName) => new THREE.MeshStandardMaterial({
    color: PALETTE[layer],
    roughness: 0.72,
    metalness: 0.02,
    transparent: layer === 'muscle',
    opacity: 1
  });

  function layerFor(mesh: THREE.Mesh): LayerName {
    const userFlag = String(mesh.userData.layer ?? mesh.userData.type ?? (mesh.userData.isBone ? 'bone' : '')).toLowerCase();
    if (userFlag === 'bone' || userFlag === 'muscle') return userFlag;
    return /(bone|vertebra|rib|skull|clavicle|scapula|humerus|radius|ulna|carpal|metacarpal|phalange|pelvis|ilium|ischium|pubis|sacrum|femur|patella|tibia|fibula|tarsal|calcaneus|talus|sternum|mandible|maxilla)/i.test(mesh.name) ? 'bone' : 'muscle';
  }

  function normalizeModel(group: THREE.Object3D): void {
    group.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(group);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const dimension = Math.max(size.x, size.y, size.z) || 1;
    group.position.sub(center);
    normalizedScale = 3.6 / dimension;
    group.scale.setScalar(normalizedScale);
    group.position.y += 0.05;
  }

  function addPart(name: string, geometry: THREE.BufferGeometry, position: [number, number, number], layer: LayerName, side?: 'left' | 'right'): void {
    const mesh = new THREE.Mesh(geometry, defaultMaterial(layer)) as Part;
    mesh.name = name;
    mesh.position.set(...position);
    mesh.userData.layer = layer;
    if (side) mesh.userData.side = side;
    mesh.castShadow = true;
    mesh.frustumCulled = true;
    model.add(mesh);
    parts.push(mesh);
  }

  function proceduralModel(): void {
    while (model.children.length) {
      const child = model.children[0];
      if (!child) break;
      model.remove(child);
      child.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) => material.dispose());
        }
      });
    }
    parts.length = 0;
    const sphere = (x: number, y: number, z: number, sx: number, sy: number, sz: number, name: string, layer: LayerName, side?: 'left' | 'right') => {
      const geometry = new THREE.SphereGeometry(1, 12, 10);
      geometry.scale(sx, sy, sz);
      addPart(name, geometry, [x, y, z], layer, side);
    };
    const bone = (x: number, y: number, z: number, sx: number, sy: number, sz: number, name: string, side?: 'left' | 'right') => sphere(x, y, z, sx, sy, sz, name, 'bone', side);
    const muscle = (x: number, y: number, z: number, sx: number, sy: number, sz: number, name: string, side?: 'left' | 'right') => sphere(x, y, z, sx, sy, sz, name, 'muscle', side);
    bone(0, 1.74, 0, .18, .23, .16, 'Skull');
    bone(0, 1.48, 0, .08, .23, .08, 'Cervical vertebrae');
    bone(0, 1.05, 0, .12, .38, .11, 'Thoracic vertebrae');
    bone(0, .55, 0, .14, .2, .13, 'Lumbar vertebrae');
    bone(0, .17, 0, .3, .16, .2, 'Pelvis');
    bone(0, 1.05, -.05, .35, .29, .12, 'Rib cage');
    bone(0, .8, .05, .12, .24, .1, 'Sternum');
    for (const side of ['left', 'right'] as const) {
      const s = side === 'left' ? -1 : 1;
      bone(s * .26, 1.39, 0, .22, .06, .06, `Clavicle.${side === 'left' ? 'l' : 'r'}`, side);
      bone(s * .34, 1.22, -.08, .2, .19, .07, `Scapula.${side === 'left' ? 'l' : 'r'}`, side);
      bone(s * .46, .93, 0, .07, .29, .07, `Humerus.${side === 'left' ? 'l' : 'r'}`, side);
      bone(s * .48, .57, .01, .035, .27, .035, `Radius.${side === 'left' ? 'l' : 'r'}`, side);
      bone(s * .41, .57, -.04, .035, .27, .035, `Ulna.${side === 'left' ? 'l' : 'r'}`, side);
      bone(s * .47, .27, .03, .06, .06, .05, `Carpal bones.${side === 'left' ? 'l' : 'r'}`, side);
      bone(s * .18, -.37, 0, .09, .54, .1, `Femur.${side === 'left' ? 'l' : 'r'}`, side);
      bone(s * .18, -.96, 0, .055, .48, .055, `Tibia.${side === 'left' ? 'l' : 'r'}`, side);
      bone(s * .25, -.96, -.02, .035, .47, .035, `Fibula.${side === 'left' ? 'l' : 'r'}`, side);
      bone(s * .18, -1.48, .09, .13, .07, .27, `Tarsal bones.${side === 'left' ? 'l' : 'r'}`, side);
      muscle(s * .17, 1.38, .07, .23, .15, .13, `Deltoid.${side === 'left' ? 'l' : 'r'}`, side);
      muscle(s * .46, .97, .09, .08, .24, .1, `Biceps brachii.${side === 'left' ? 'l' : 'r'}`, side);
      muscle(s * .43, .69, .08, .06, .2, .08, `Brachioradialis.${side === 'left' ? 'l' : 'r'}`, side);
      muscle(s * .18, -.33, .08, .16, .35, .13, `Rectus femoris.${side === 'left' ? 'l' : 'r'}`, side);
      muscle(s * .29, -.35, -.01, .09, .34, .11, `Biceps femoris.${side === 'left' ? 'l' : 'r'}`, side);
      muscle(s * .18, -1.04, .09, .09, .3, .1, `Gastrocnemius.${side === 'left' ? 'l' : 'r'}`, side);
      muscle(s * .16, -1.28, .11, .06, .24, .07, `Soleus.${side === 'left' ? 'l' : 'r'}`, side);
      muscle(s * .31, .17, .01, .2, .2, .14, `Gluteus maximus.${side === 'left' ? 'l' : 'r'}`, side);
      muscle(s * .24, .99, .1, .1, .27, .08, `Triceps brachii.${side === 'left' ? 'l' : 'r'}`, side);
    }
    muscle(0, 1.72, .08, .18, .2, .11, 'Masseter');
    muscle(0, 1.37, .02, .09, .2, .08, 'Sternocleidomastoid');
    muscle(0, 1.08, .15, .3, .26, .08, 'Pectoralis major');
    muscle(0, .72, .12, .14, .31, .08, 'Rectus abdominis');
    muscle(0, .42, .1, .28, .12, .08, 'External oblique');
    muscle(0, 1.02, -.15, .31, .33, .09, 'Latissimus dorsi');
  }

  function populateModel(group: THREE.Object3D): void {
    model.clear();
    parts.length = 0;
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const mesh = object as Part;
      mesh.frustumCulled = true;
      mesh.userData.layer = layerFor(mesh);
      const match = mesh.name.match(/(?:\.l|_l| left)$/i);
      if (match || /^(?:l|left)$/i.test(String(mesh.userData.side ?? ''))) mesh.userData.side = 'left';
      if (/(?:\.r|_r| right)$/i.test(mesh.name) || /^(?:r|right)$/i.test(String(mesh.userData.side ?? ''))) mesh.userData.side = 'right';
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map((old) => {
          const material = new THREE.MeshStandardMaterial({ color: (old as THREE.MeshStandardMaterial).color ?? PALETTE[mesh.userData.layer ?? 'muscle'], roughness: .72 });
          old.dispose();
          return material;
        });
      } else {
        mesh.material = defaultMaterial(mesh.userData.layer);
      }
      parts.push(mesh);
    });
    model.add(group);
    normalizeModel(model);
    progress.hidden = true;
    applyFilters();
    renderPartList();
    window.dispatchEvent(new Event('anatomy-model-ready'));
  }

  function matchesRegion(part: Part, region: string): boolean {
    if (region === 'Full body') return true;
    const patterns = regions[region as RegionName] ?? [];
    const name = part.name.toLowerCase();
    return patterns.some((pattern) => name.includes(pattern.toLowerCase()));
  }

  function applyFilters(): void {
    const layerInputs = controls.querySelectorAll<HTMLInputElement>('[data-layer]');
    const layerEnabled = new Map<string, boolean>();
    layerInputs.forEach((input) => layerEnabled.set(input.dataset.layer ?? '', input.checked));
    const side = controls.querySelector<HTMLSelectElement>('#side-filter')?.value ?? 'both';
    const mode = controls.querySelector<HTMLInputElement>('input[name="isolation"]:checked')?.value ?? 'hide';
    isolation = mode === 'ghost' ? 'ghost' : 'hide';
    for (const part of parts) {
      const layerVisible = layerEnabled.get(part.userData.layer ?? 'muscle') ?? true;
      const sideVisible = side === 'both' || !part.userData.side || part.userData.side === side;
      const regionVisible = matchesRegion(part, currentRegion);
      const otherVisible = regionVisible || currentRegion === 'Full body';
      part.visible = layerVisible && sideVisible && (otherVisible || isolation === 'ghost');
      const materials = Array.isArray(part.material) ? part.material : [part.material];
      materials.forEach((material) => {
        const standard = material as THREE.MeshStandardMaterial;
        const muscleOpacity = Number(controls.querySelector<HTMLInputElement>('#muscle-opacity')?.value ?? 100) / 100;
        const ghosted = !regionVisible && currentRegion !== 'Full body';
        standard.transparent = part.userData.layer === 'muscle' || ghosted;
        standard.opacity = ghosted ? .08 : part.userData.layer === 'muscle' ? muscleOpacity : 1;
        standard.emissive.set(part === selectedPart ? 0x287e8d : 0x000000);
        standard.emissiveIntensity = part === selectedPart ? .55 : 0;
        standard.needsUpdate = true;
      });
    }
  }

  function focus(partsToFrame: Part[]): void {
    if (!partsToFrame.length) return;
    const box = new THREE.Box3();
    partsToFrame.forEach((part) => box.expandByObject(part));
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const extent = box.getSize(new THREE.Vector3());
    const radius = Math.max(extent.x, extent.y, extent.z, .4);
    const direction = camera.position.clone().sub(controls3d.target).normalize();
    animationTarget = {
      target: center,
      position: center.clone().add(direction.multiplyScalar(Math.max(1.7, radius * 2.6)))
    };
  }

  function renderPartList(): void {
    const filter = search.value.toLowerCase();
    partList.replaceChildren();
    for (const part of parts.filter((item) => item.name.toLowerCase().includes(filter)).slice(0, 250)) {
      const item = button(part.name, () => selectPart(part), 'part-list-item');
      item.setAttribute('role', 'option');
      partList.append(item);
    }
  }

  function selectPart(part: Part): void {
    selectedPart = part;
    applyFilters();
    selectionCard.replaceChildren(
      element('strong', { text: part.name, attrs: { id: 'selected-part-name' } }),
      button('Focus', () => focus([part]), 'button button-secondary'),
      button('Isolate this', () => { currentRegion = 'Full body'; for (const item of parts) item.visible = item === part; focus([part]); }, 'button button-secondary'),
      button('Hide this', () => { part.visible = false; }, 'button button-secondary'),
      button('Show all', () => { currentRegion = 'Full body'; regionSelect.value = currentRegion; applyFilters(); }, 'button button-secondary')
    );
    focus([part]);
    const region = REGION_NAMES.find((name) => name !== 'Full body' && matchesRegion(part, name));
    if (region) {
      currentRegion = region;
      regionSelect.value = region;
      applyFilters();
    }
  }

  for (const region of REGION_NAMES) regionSelect.add(new Option(region, region));
  regionSelect.addEventListener('change', () => {
    currentRegion = regionSelect.value;
    applyFilters();
    focus(parts.filter((part) => matchesRegion(part, currentRegion)));
  });
  search.addEventListener('input', renderPartList);

  const regionLabel = element('label', { text: 'Region' });
  regionLabel.append(regionSelect);
  const isolationRow = element('fieldset', { className: 'control-group' });
  isolationRow.append(element('legend', { text: 'Isolate other parts' }));
  for (const value of ['hide', 'ghost'] as const) {
    const label = element('label');
    const input = element('input', { attrs: { type: 'radio', name: 'isolation', value } });
    input.checked = value === 'hide';
    input.addEventListener('change', applyFilters);
    label.append(input, document.createTextNode(value === 'hide' ? 'Hide' : 'Ghost (8%)'));
    isolationRow.append(label);
  }
  const layerGroup = element('fieldset', { className: 'control-group' });
  layerGroup.append(element('legend', { text: 'Layers and sides' }));
  for (const [layer, text] of [['bone', 'Bones'], ['muscle', 'Muscles']] as const) {
    const label = element('label');
    const input = element('input', { attrs: { type: 'checkbox', 'data-layer': layer } });
    input.checked = true;
    input.addEventListener('change', applyFilters);
    label.append(input, document.createTextNode(text));
    layerGroup.append(label);
  }
  const sideFilter = element('select', { attrs: { id: 'side-filter', 'aria-label': 'Side filter' } });
  for (const [value, text] of [['both', 'Both sides'], ['left', 'Left'], ['right', 'Right']]) sideFilter.add(new Option(text, value));
  sideFilter.addEventListener('change', applyFilters);
  const opacityLabel = element('label', { text: 'Muscle opacity' });
  const opacity = element('input', { attrs: { id: 'muscle-opacity', type: 'range', min: '10', max: '100', value: '100' } });
  opacity.addEventListener('input', applyFilters);
  opacityLabel.append(opacity);
  const scaleLabel = element('label', { text: 'Model scale' });
  const scale = element('input', { attrs: { type: 'range', min: '60', max: '150', value: '100' } });
  scale.addEventListener('input', () => { scaleFactor = Number(scale.value) / 100; model.scale.setScalar(normalizedScale * scaleFactor); });
  scaleLabel.append(scale);
  const presetViews = element('div', { className: 'preset-buttons' });
  const setView = (position: THREE.Vector3) => { animationTarget = { position: position.multiplyScalar(scaleFactor), target: controls3d.target.clone() }; };
  presetViews.append(
    button('Front', () => setView(new THREE.Vector3(0, 1.15, 5)), 'button button-secondary'),
    button('Back', () => setView(new THREE.Vector3(0, 1.15, -5)), 'button button-secondary'),
    button('Left', () => setView(new THREE.Vector3(-5, 1.15, 0)), 'button button-secondary'),
    button('Right', () => setView(new THREE.Vector3(5, 1.15, 0)), 'button button-secondary'),
    button('Reset', () => { camera.position.set(0, 1.2, 7); controls3d.target.set(0, 1, 0); model.scale.setScalar(normalizedScale); scale.value = '100'; scaleFactor = 1; }, 'button button-secondary')
  );
  const presentation = element('div', { className: 'control-group presentation-tools' });
  presentation.append(
    button('Presentation mode', () => {
      section.classList.add('presentation-mode');
      section.closest('.app-shell')?.classList.add('presentation-active');
    }, 'button button-secondary'),
    button('Save current view as step', () => {
      const caption = window.prompt('Presentation caption');
      if (caption === null) return;
      steps.push({
        title: currentRegion,
        caption,
        region: currentRegion,
        ...(selectedPart ? { meshNames: [selectedPart.name] } : {}),
        cameraPosition: camera.position.toArray() as [number, number, number],
        target: controls3d.target.toArray() as [number, number, number]
      });
      void savePresentation(steps).then(() => showMessage('Presentation step saved.', 'success'));
    }, 'button button-secondary'),
    button('Previous step', () => playStep(stepIndex - 1), 'button button-secondary'),
    button('Next step', () => playStep(stepIndex + 1), 'button button-secondary'),
    button('Export steps', () => {
      const blob = new Blob([JSON.stringify(steps, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = element('a', { attrs: { href: url, download: 'anatomy-presentation.json' } });
      a.click();
      URL.revokeObjectURL(url);
    }, 'button button-secondary')
  );
  function playStep(index: number): void {
    if (!steps.length) return;
    stepIndex = (index + steps.length) % steps.length;
    const step = steps[stepIndex];
    if (!step) return;
    currentRegion = step.region ?? 'Full body';
    regionSelect.value = currentRegion;
    applyFilters();
    if (step.meshNames?.length) {
      const names = new Set(step.meshNames);
      for (const part of parts) part.visible = names.has(part.name);
    }
    animationTarget = { position: new THREE.Vector3(...step.cameraPosition), target: new THREE.Vector3(...step.target) };
    showMessage(step.caption || step.title);
  }

  controls.append(
    regionLabel,
    button('Full body', () => { currentRegion = 'Full body'; regionSelect.value = currentRegion; applyFilters(); }, 'button button-secondary'),
    isolationRow,
    layerGroup,
    sideFilter,
    opacityLabel,
    scaleLabel,
    presetViews,
    element('label', { text: 'Search parts' }),
    search,
    partList,
    presentation
  );
  section.append(header, workspace);
  workspace.append(controls, viewport);
  const presentationOverlay = element('div', { className: 'presentation-overlay' });
  presentationOverlay.append(
    button('Previous', () => playStep(stepIndex - 1), 'button button-secondary'),
    button('Next', () => playStep(stepIndex + 1), 'button button-secondary'),
    button('Exit presentation', () => {
      section.classList.remove('presentation-mode');
      section.closest('.app-shell')?.classList.remove('presentation-active');
    }, 'button button-primary')
  );
  viewport.append(presentationOverlay);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pointerDownAt = 0;
  let pointerStart: [number, number] = [0, 0];
  canvas.addEventListener('pointerdown', (event) => { pointerDownAt = Date.now(); pointerStart = [event.clientX, event.clientY]; });
  canvas.addEventListener('pointerup', (event) => {
    if (Date.now() - pointerDownAt > 350 || Math.hypot(event.clientX - pointerStart[0], event.clientY - pointerStart[1]) > 10) return;
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(parts, false)[0]?.object as Part | undefined;
    if (hit) selectPart(hit);
  });
  let lastTap = 0;
  let swipeStart: [number, number, number] | undefined;
  canvas.addEventListener('touchstart', (event) => {
    if (event.touches.length === 1) swipeStart = [event.touches[0]?.clientX ?? 0, event.touches[0]?.clientY ?? 0, Date.now()];
  }, { passive: true });
  canvas.addEventListener('touchend', () => {
    const now = Date.now();
    if (now - lastTap < 320) {
      camera.position.set(0, 1.2, 7);
      controls3d.target.set(0, 1, 0);
    }
    lastTap = now;
  }, { passive: true });
  canvas.addEventListener('touchend', (event) => {
    if (!swipeStart || !steps.length) return;
    const touch = event.changedTouches[0];
    const dx = (touch?.clientX ?? swipeStart[0]) - swipeStart[0];
    const dy = (touch?.clientY ?? swipeStart[1]) - swipeStart[1];
    if (Date.now() - swipeStart[2] < 600 && Math.abs(dx) > 90 && Math.abs(dy) < 60) playStep(stepIndex + (dx < 0 ? 1 : -1));
    swipeStart = undefined;
  }, { passive: true });

  function animate(): void {
    frame = requestAnimationFrame(animate);
    if (!visible || document.hidden) return;
    if (animationTarget) {
      camera.position.lerp(animationTarget.position, .08);
      controls3d.target.lerp(animationTarget.target, .08);
      if (camera.position.distanceTo(animationTarget.position) < .025 && controls3d.target.distanceTo(animationTarget.target) < .025) animationTarget = undefined;
    }
    controls3d.update();
    renderer.render(scene, camera);
  }
  const visibility = () => { visible = !document.hidden; };
  document.addEventListener('visibilitychange', visibility);
  const intersectionObserver = new IntersectionObserver((entries) => { visible = entries[0]?.isIntersecting ?? false; });
  intersectionObserver.observe(viewport);
  animate();
  resize();

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.load(
    `${import.meta.env.BASE_URL}models/anatomy.glb`,
    (gltf) => populateModel(gltf.scene),
    (event) => { if (event.total) progress.value = Math.round(event.loaded / event.total * 100); },
    () => {
      progress.hidden = true;
      proceduralModel();
      normalizeModel(model);
      applyFilters();
      renderPartList();
      hint.textContent = 'Procedural demonstration model · Add public/models/anatomy.glb for the full Z-Anatomy model.';
      window.dispatchEvent(new Event('anatomy-model-ready'));
    }
  );
  void loadPresentation().then((saved) => { steps = saved; });

  if (import.meta.env.DEV) {
    const debug = element('details', { className: 'debug-unmatched' });
    const summary = element('summary', { text: 'Debug: unmatched model names' });
    const unmatched = element('ul');
    debug.append(summary, unmatched);
    section.append(debug);
    const updateDebug = () => {
      unmatched.replaceChildren();
      const names = new Set(parts.filter((part) => !Object.keys(regions).some((name) => matchesRegion(part, name))).map((part) => part.name));
      for (const name of names) unmatched.append(element('li', { text: name }));
    };
    updateDebug();
    window.addEventListener('anatomy-model-ready', updateDebug, { once: true });
  }

  window.addEventListener('beforeunload', () => {
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    intersectionObserver.disconnect();
    document.removeEventListener('visibilitychange', visibility);
    controls3d.dispose();
    renderer.dispose();
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) => material.dispose());
      }
    });
  }, { once: true });
  return section;
}
