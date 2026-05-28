import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';
import { loadGLB } from './glbLoader.js';
import { createPlayer, updateMovement } from './player.js';

//delete window.XRWebGLBinding;
if ('XRWebGLBinding' in window) {
  delete window.XRWebGLBinding;
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1.6, 3);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);

renderer.xr.enabled = true;

document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

// ambient lights
const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 2);
hemiLight.position.set(0, 20, 0);
scene.add(hemiLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 2);
dirLight.position.set(3, 10, 10);
scene.add(dirLight);

// model
const model = await loadGLB("/models/apartment_2_4f7f_in_japan.glb");
scene.add(model);

// player
const player = createPlayer(camera);
scene.add(player);

// controller
const controllerModelFactory = new XRControllerModelFactory();

for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);
  player.add(controller);

  const grip = renderer.xr.getControllerGrip(i);
  grip.add(controllerModelFactory.createControllerModel(grip));
  player.add(grip);
}


function getVRJoystick(): { x: number; y: number } {
  const session = renderer.xr.getSession();
  if (!session) return { x: 0, y: 0 };

  for (const source of session.inputSources) {
    const gp = source.gamepad;
    if (!gp || gp.axes.length < 4) continue;
    const x = gp.axes[2]; // joystick gauche horizontal
    const y = gp.axes[3]; // joystick gauche vertical
    if (Math.abs(x) > 0.1 || Math.abs(y) > 0.1) return { x, y }; // deadzone
  }
  return { x: 0, y: 0 };
}

const timer = new THREE.Timer();

renderer.setAnimationLoop(() =>
{
  timer.update();

  renderer.xr.updateCamera(camera);

  if (renderer.xr.isPresenting) {
    const joystick = getVRJoystick();
    updateMovement(player, camera, joystick);
    renderer.render(scene, camera);
  }
});

window.addEventListener('resize', () =>
{
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});