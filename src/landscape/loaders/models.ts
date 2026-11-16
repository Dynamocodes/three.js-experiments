import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Drop-in models: .glb files in src/assets/models/<category>/ are picked up
// automatically (Vite discovers them at build time, no code changes). See
// src/assets/README.md for the categories. No files => the procedural
// placeholder is used instead.
const files = import.meta.glob<string>('../../assets/models/*/*.{glb,gltf}', {
  query: '?url',
  import: 'default',
  eager: true,
});

/** Model URLs by category (the folder name), sorted by file name. */
export const modelUrls: Record<string, string[]> = {};
for (const [path, url] of Object.entries(files)) {
  const category = path.split('/').at(-2) ?? 'misc';
  (modelUrls[category] ??= []).push(url);
}
for (const list of Object.values(modelUrls)) list.sort();

// Meshopt-compressed GLBs (gltf-transform optimize --compress meshopt) decode
// with a decoder bundled in three, no extra hosting needed.
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

/** One geometry and its material: becomes one InstancedMesh. */
export interface InstancePart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export type LoadInstanceParts = (url: string, options: { height: number }) => Promise<InstancePart[]>;

/**
 * Loads a model and flattens it into "parts": one geometry per material, with
 * every node transform baked in. Each part becomes one InstancedMesh, so a
 * model with bark + needles + snow materials costs three draw calls total no
 * matter how many copies are placed.
 *
 * The model is normalised: origin moved to the centre of its base and scaled
 * so its height equals `height`. That way the scale it was exported at
 * doesn't matter.
 */
export const loadInstanceParts: LoadInstanceParts = async (url, { height }) => {
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;
  root.updateMatrixWorld(true);

  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mesh = obj as THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((mat, i) => {
      let geo = mesh.geometry.clone();
      if (mats.length > 1) {
        // Split multi-material meshes by group.
        const group = geo.groups[i];
        if (!group) return;
        geo = extractGroup(geo, group);
      }
      geo.applyMatrix4(mesh.matrixWorld);
      geo.morphAttributes = {}; // static scenery: drop morph targets
      // Keep only attributes everything shares, so parts can merge.
      for (const name of Object.keys(geo.attributes)) {
        if (!['position', 'normal', 'uv', 'color'].includes(name)) geo.deleteAttribute(name);
      }
      const list = byMaterial.get(mat) ?? [];
      list.push(geo);
      byMaterial.set(mat, list);
    });
  });

  const parts: InstancePart[] = [];
  const box = new THREE.Box3();
  for (const [material, geos] of byMaterial) {
    const geometry = geos.length === 1 ? geos[0] : mergeGeometries(harmonise(geos));
    if (!geometry) continue;
    parts.push({ geometry, material });
    geometry.computeBoundingBox();
    if (geometry.boundingBox) box.union(geometry.boundingBox);
  }

  // Normalise origin and size.
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = height / (size.y || 1);
  for (const { geometry, material } of parts) {
    geometry.translate(-center.x, -box.min.y, -center.z);
    geometry.scale(s, s, s);
    geometry.computeBoundingSphere();
    const map = (material as THREE.MeshStandardMaterial).map;
    if (map) map.colorSpace = THREE.SRGBColorSpace;
  }
  return parts;
};

/** Loads a whole model as a normal scene graph (for one-off hero objects). */
export async function loadModel(url: string, { height }: { height: number }) {
  const gltf = await loader.loadAsync(url);
  const root = gltf.scene;
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const s = height / (size.y || 1);
  const pivot = new THREE.Group();
  root.position.set(-center.x, -box.min.y, -center.z);
  pivot.add(root);
  pivot.scale.setScalar(s);
  return { object: pivot, animations: gltf.animations, size: size.multiplyScalar(s) };
}

function extractGroup(geo: THREE.BufferGeometry, group: { start: number; count: number }) {
  const out = geo.index ? geo.toNonIndexed() : geo;
  const { start, count } = group;
  const sub = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(out.attributes)) {
    const a = attr as THREE.BufferAttribute;
    const arr = a.array.slice(start * a.itemSize, (start + count) * a.itemSize);
    sub.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
  }
  return sub;
}

// mergeGeometries needs identical attribute sets and all-indexed or none.
function harmonise(geos: THREE.BufferGeometry[]) {
  const first = geos[0];
  const common = Object.keys(first.attributes).filter((n) => geos.every((g) => g.attributes[n]));
  return geos.map((g) => {
    const out = g.index ? g.toNonIndexed() : g;
    for (const n of Object.keys(out.attributes)) if (!common.includes(n)) out.deleteAttribute(n);
    return out;
  });
}
