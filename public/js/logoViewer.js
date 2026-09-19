// Mounts the real 3D Chunguza logo (public/js/chunguza-logo-model.js) into any
// <canvas data-chunguza-logo="mark|full"> on the page, via a CDN-loaded Three.js
// (this frontend has no build step, so an import map — see each page's <head> —
// resolves the bare "three" / "three/addons/" specifiers the model file uses).
//
// Same real-integration + safe-fallback idiom as the rest of this codebase
// (companyProfileService, emailGenerationService, ...): if WebGL, the CDN, or
// font loading fails for any reason, we quietly leave the plain-text "C" mark
// that already sits next to each canvas visible, instead of breaking the page.
import * as THREE from 'three';
import { buildLogo } from './chunguza-logo-model.js';

const ROTATE_SPEED = 0.006;

export async function mountChunguzaLogo(canvas, opts = {}) {
  try {
    if (!canvas || typeof window === 'undefined' || !window.WebGLRenderingContext) return false;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
    camera.position.set(0, 0.1, opts.markOnly ? 3.6 : 4.6);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(2.2, 2.6, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9184d9, 0.55);
    rim.position.set(-2.5, -1.2, -2);
    scene.add(rim);

    const logo = await buildLogo({ markOnly: !!opts.markOnly });
    scene.add(logo);

    const resize = () => {
      const w = Math.max(canvas.clientWidth, 1);
      const h = Math.max(canvas.clientHeight, 1);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener('resize', resize);

    const spin = opts.autoRotate !== false;
    let frame;
    const tick = () => {
      if (spin) logo.rotation.y += ROTATE_SPEED;
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    tick();

    canvas._chunguzaLogoDispose = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      renderer.dispose();
    };
    return true;
  } catch (err) {
    console.warn('Chunguza 3D logo unavailable, using the static mark instead.', (err && err.message) || err);
    return false;
  }
}

export function autoMountLogos(root = document) {
  root.querySelectorAll('canvas[data-chunguza-logo]').forEach(async (canvas) => {
    const markOnly = canvas.dataset.chunguzaLogo === 'mark';
    const fallback = canvas.parentElement ? canvas.parentElement.querySelector('[data-logo-fallback]') : null;
    const ok = await mountChunguzaLogo(canvas, { markOnly, autoRotate: canvas.dataset.spin !== 'false' });
    if (ok) {
      canvas.style.opacity = '1';
      if (fallback) fallback.style.display = 'none';
    } else {
      canvas.style.display = 'none';
    }
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => autoMountLogos());
  } else {
    autoMountLogos();
  }
}
