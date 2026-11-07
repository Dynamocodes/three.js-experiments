import * as THREE from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { LAKE } from './terrain.js';

// A mirror plane: the lake reflects the aurora, sky and treeline.
// Rendered at reduced resolution since it's a second scene render.
export function createWater(renderer) {
  const geo = new THREE.PlaneGeometry(LAKE.rx * 2.6, LAKE.rz * 2.6);
  const scale = 0.5;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());

  const water = new Reflector(geo, {
    color: 0x7a8aa0,
    textureWidth: Math.max(256, Math.floor(size.x * scale)),
    textureHeight: Math.max(256, Math.floor(size.y * scale)),
    clipBias: 0.003,
  });
  water.rotation.x = -Math.PI / 2;
  water.position.set(LAKE.x, LAKE.waterLevel, LAKE.z);
  water.name = 'lake';

  const resize = () => {
    renderer.getDrawingBufferSize(size);
    water.getRenderTarget().setSize(
      Math.max(256, Math.floor(size.x * scale)),
      Math.max(256, Math.floor(size.y * scale)),
    );
  };

  return { object: water, resize };
}
