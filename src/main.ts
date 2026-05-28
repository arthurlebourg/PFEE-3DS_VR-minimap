import * as THREE from 'three';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

delete window.XRWebGLBinding;

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

// load a glb ressource
const loader = new GLTFLoader();
loader.load(
  '/models/apartment_2_4f7f_in_japan.glb', // file path
  (gltf) =>
  {
    const model = gltf.scene;
    model.position.set(0, 1.2, -2);
    model.scale.set(0.01, 0.01, 0.01);
    scene.add(model);
    console.log('Model loaded successfully');
  },
  // log progress details disabled
  (xhr) => { /* console.log((xhr.loaded / xhr.total * 100) + '%'); */ },
  (error) => { console.error('Error loading model:', error); }
);

renderer.setAnimationLoop(() =>
{
  renderer.render(scene, camera);
});

window.addEventListener('resize', () =>
{
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
