import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';

const BASE_SPEED = 18;     // units/sec
const SPRINT_MULT = 3;

export interface FlyControls {
  controls: PointerLockControls;
  update(dt: number): void;
  isLocked(): boolean;
  dispose(): void;
}

export function createFlyControls(camera: THREE.Camera, dom: HTMLElement): FlyControls {
  const controls = new PointerLockControls(camera, dom);
  const keys = new Set<string>();
  const onDown = (e: KeyboardEvent) => {
    keys.add(e.code);
    // Prevent space from scrolling the page when not locked.
    if (e.code === 'Space') e.preventDefault();
  };
  const onUp = (e: KeyboardEvent) => keys.delete(e.code);
  document.addEventListener('keydown', onDown);
  document.addEventListener('keyup', onUp);

  const onClick = () => { if (!controls.isLocked) controls.lock(); };
  dom.addEventListener('click', onClick);

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const move = new THREE.Vector3();

  return {
    controls,
    isLocked: () => controls.isLocked,
    update(dt: number) {
      if (!controls.isLocked) return;
      const speed = BASE_SPEED * (keys.has('ControlLeft') || keys.has('ControlRight') ? SPRINT_MULT : 1);

      camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      right.crossVectors(forward, up).normalize();

      move.set(0, 0, 0);
      if (keys.has('KeyW') || keys.has('ArrowUp'))    move.add(forward);
      if (keys.has('KeyS') || keys.has('ArrowDown'))  move.sub(forward);
      if (keys.has('KeyD') || keys.has('ArrowRight')) move.add(right);
      if (keys.has('KeyA') || keys.has('ArrowLeft'))  move.sub(right);
      if (keys.has('Space'))                          move.y += 1;
      if (keys.has('ShiftLeft') || keys.has('ShiftRight')) move.y -= 1;

      if (move.lengthSq() === 0) return;
      move.normalize().multiplyScalar(speed * dt);
      camera.position.add(move);
    },
    dispose() {
      document.removeEventListener('keydown', onDown);
      document.removeEventListener('keyup', onUp);
      dom.removeEventListener('click', onClick);
      controls.disconnect();
    },
  };
}
