import { useEffect, useRef } from 'react';

/**
 * A real 3D helicopter (three.js, built from primitives, no model files) that
 * flies a random curved path across the screen towing a waving banner.
 *
 * - Every mount gets a new random path, height, depth, speed and banner words.
 * - Touch / click / key anywhere and it fades out and frees the GPU at once.
 *   (The touch is not swallowed, so whatever you tapped still works.)
 * - Needs `npm i three`. It is loaded lazily, so other pages don't pay for it.
 * - Nothing renders under prefers-reduced-motion or if WebGL is unavailable.
 *
 * Remount it (change the `key`) to replay.
 */

const PHRASES = [
  'Gist on the way',
  'Fresh gist, hot off the press',
  'Someone is typing...',
  'Your crush just got online',
  'New drop, go collect',
  'Plot twist incoming',
  'Reply them, they are waiting',
  'Special delivery',
  'Low-flying gist alert',
  'Someone asked about you',
  'Weekend plans loading...',
  'Spill the tea',
  'Cupid air service',
  'Vibes delivered, no delay',
  'Do not leave them on read',
  'Hello from above',
];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function bannerCanvas(text, mirror) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const g = c.getContext('2d');
  if (mirror) { g.translate(c.width, 0); g.scale(-1, 1); }
  g.fillStyle = '#f7b928';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#e8451f';
  g.fillRect(0, 0, c.width, 10);
  g.fillRect(0, c.height - 10, c.width, 10);
  g.fillStyle = '#1f1d3d';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 54;
  g.font = `800 ${size}px Sora, system-ui, sans-serif`;
  while (g.measureText(text).width > c.width - 40 && size > 20) {
    size -= 2;
    g.font = `800 ${size}px Sora, system-ui, sans-serif`;
  }
  g.fillText(text, c.width / 2, c.height / 2 + 3);
  return c;
}

export default function Chopper() {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let cancelled = false;
    let cleanup = () => {};

    import('three')
      .then((THREE) => {
        if (cancelled) return;

        let renderer;
        try {
          renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
        } catch {
          return; // no WebGL: just don't show it
        }
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setClearColor(0x000000, 0);

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
        camera.position.set(0, 0, 20);

        scene.add(new THREE.HemisphereLight(0xffffff, 0x6a5acd, 1.05));
        const sun = new THREE.DirectionalLight(0xffffff, 2.1);
        sun.position.set(-5, 8, 9);
        scene.add(sun);

        const disposables = [];
        const mat = (color, opts = {}) => {
          const m = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.15, ...opts });
          disposables.push(m);
          return m;
        };
        const geo = (g) => { disposables.push(g); return g; };

        const red = mat(0xe8451f);
        const darkRed = mat(0xc23512);
        const blue = mat(0x2d3fd1);
        const yellow = mat(0xf7b928);
        const ink = mat(0x1f1d3d, { roughness: 0.6 });
        const glass = mat(0xbfe3ff, { roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.82 });
        const skin = mat(0xa8623a);

        // ---------- the helicopter (nose points to +X) ----------
        const heli = new THREE.Group();
        const model = new THREE.Group(); // gets the bank / bob on top of the heading
        heli.add(model);

        const body = new THREE.Mesh(geo(new THREE.SphereGeometry(1, 32, 24)), red);
        body.scale.set(1.15, 0.62, 0.6);
        model.add(body);

        const belly = new THREE.Mesh(geo(new THREE.SphereGeometry(1, 24, 16)), yellow);
        belly.scale.set(1.0, 0.16, 0.56);
        belly.position.set(0.02, -0.34, 0);
        model.add(belly);

        const cockpit = new THREE.Mesh(geo(new THREE.SphereGeometry(1, 32, 20)), glass);
        cockpit.scale.set(0.55, 0.42, 0.5);
        cockpit.position.set(0.72, 0.16, 0);
        model.add(cockpit);

        const pilot = new THREE.Mesh(geo(new THREE.SphereGeometry(0.17, 16, 12)), skin);
        pilot.position.set(0.72, 0.16, 0.06);
        model.add(pilot);
        const cap = new THREE.Mesh(geo(new THREE.SphereGeometry(0.18, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)), ink);
        cap.position.set(0.72, 0.2, 0.06);
        model.add(cap);

        const boom = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.1, 0.2, 1.9, 14)), blue);
        boom.rotation.z = Math.PI / 2;
        boom.position.set(-1.9, 0.12, 0);
        model.add(boom);

        const fin = new THREE.Mesh(geo(new THREE.BoxGeometry(0.34, 0.62, 0.06)), darkRed);
        fin.position.set(-2.82, 0.4, 0);
        fin.rotation.z = -0.35;
        model.add(fin);

        const mast = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.06, 0.08, 0.3, 10)), ink);
        mast.position.set(0, 0.7, 0);
        model.add(mast);

        const rotor = new THREE.Group();
        rotor.position.set(0, 0.86, 0);
        const bladeGeo = geo(new THREE.BoxGeometry(3.3, 0.025, 0.14));
        const blade1 = new THREE.Mesh(bladeGeo, ink);
        const blade2 = new THREE.Mesh(bladeGeo, ink);
        blade2.rotation.y = Math.PI / 2;
        rotor.add(blade1, blade2);
        // soft disc so the spinning rotor reads as a blur, like the real thing
        const disc = new THREE.Mesh(
          geo(new THREE.CircleGeometry(1.65, 40)),
          mat(0x1f1d3d, { transparent: true, opacity: 0.1, side: THREE.DoubleSide, roughness: 1, metalness: 0 })
        );
        disc.rotation.x = -Math.PI / 2;
        rotor.add(disc);
        model.add(rotor);

        const tailRotor = new THREE.Group();
        tailRotor.position.set(-2.88, 0.42, 0.1);
        const tBlade = new THREE.Mesh(geo(new THREE.BoxGeometry(0.04, 0.62, 0.07)), ink);
        const tBlade2 = tBlade.clone();
        tBlade2.rotation.x = Math.PI / 2;
        tailRotor.add(tBlade, tBlade2);
        model.add(tailRotor);

        // skids
        const skidGeo = geo(new THREE.CylinderGeometry(0.035, 0.035, 1.9, 8));
        const strutGeo = geo(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8));
        [-0.42, 0.42].forEach((z) => {
          const skid = new THREE.Mesh(skidGeo, ink);
          skid.rotation.z = Math.PI / 2;
          skid.position.set(0.05, -0.74, z);
          model.add(skid);
          [-0.5, 0.55].forEach((x) => {
            const strut = new THREE.Mesh(strutGeo, ink);
            strut.position.set(x, -0.54, z * 0.92);
            model.add(strut);
          });
        });

        // ---------- the banner it tows ----------
        const phrase = pick(PHRASES);
        const texFront = new THREE.CanvasTexture(bannerCanvas(phrase, false));
        const texBack = new THREE.CanvasTexture(bannerCanvas(phrase, true));
        [texFront, texBack].forEach((t) => { t.anisotropy = 4; t.colorSpace = THREE.SRGBColorSpace; disposables.push(t); });
        const BW = 3.0;
        const BH = 0.75;
        const bannerGeo = geo(new THREE.PlaneGeometry(BW, BH, 24, 1));
        const frontMat = mat(0xffffff, { map: texFront, side: THREE.FrontSide, roughness: 0.9, metalness: 0 });
        const backMat = mat(0xffffff, { map: texBack, side: THREE.BackSide, roughness: 0.9, metalness: 0 });
        const banner = new THREE.Group();
        banner.add(new THREE.Mesh(bannerGeo, frontMat), new THREE.Mesh(bannerGeo, backMat));
        // plane's local +X runs to the right; the banner trails to -X of the craft, so flip it to read left-to-right when the nose points +X
        banner.position.set(-2.9 - 0.25 - BW / 2, 0.12, 0);
        model.add(banner);

        const ropeGeo = geo(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 4));
        const rope = new THREE.Mesh(ropeGeo, ink);
        rope.rotation.z = Math.PI / 2;
        rope.position.set(-2.9 - 0.12, 0.12, 0);
        model.add(rope);

        scene.add(heli);

        // ---------- sizing ----------
        let halfW = 10;
        let halfH = 7;
        const resize = () => {
          const w = window.innerWidth;
          const h = window.innerHeight;
          renderer.setSize(w, h, false);
          canvas.style.width = '100%'; // CSS size, so high-DPI screens don't blow the canvas up
          canvas.style.height = '100%';
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          halfH = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z;
          halfW = halfH * camera.aspect;
          // keep it small on every screen: roughly a quarter of the width
          const s = Math.min(1, Math.max(0.35, (halfW * 2 * 0.3) / 7));
          heli.scale.setScalar(s);
        };
        resize();
        window.addEventListener('resize', resize);

        // ---------- random path ----------
        const fromLeft = Math.random() < 0.5;
        const dir = fromLeft ? 1 : -1;
        const margin = 6.5;
        const pts = [
          new THREE.Vector3(-dir * (halfW + margin), rand(-halfH, halfH) * 0.9, rand(-3, 3)),
          new THREE.Vector3(-dir * halfW * rand(0.45, 0.8), rand(-halfH, halfH) * 0.8, rand(-5, 3)),
          new THREE.Vector3(dir * halfW * rand(-0.1, 0.3), rand(-halfH, halfH) * 0.8, rand(-5, 4)),
          new THREE.Vector3(dir * halfW * rand(0.5, 0.85), rand(-halfH, halfH) * 0.8, rand(-5, 3)),
          new THREE.Vector3(dir * (halfW + margin), rand(-halfH, halfH) * 0.9, rand(-3, 3)),
        ];
        const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5);
        const duration = rand(5.5, 7); // seconds

        // ---------- loop ----------
        const clock = new THREE.Clock();
        let raf = 0;
        let ending = false;
        let fade = 1;
        let yawPrev = null;
        let bank = 0;
        let done = false;
        const T = new THREE.Vector3();
        const P = new THREE.Vector3();
        const bannerPos = bannerGeo.attributes.position;
        const baseX = Float32Array.from({ length: bannerPos.count }, (_, i) => bannerPos.getX(i));
        const baseY = Float32Array.from({ length: bannerPos.count }, (_, i) => bannerPos.getY(i));

        const finish = () => {
          if (done) return;
          done = true;
          cancelAnimationFrame(raf);
          window.removeEventListener('resize', resize);
          removeListeners();
          disposables.forEach((d) => d.dispose && d.dispose());
          renderer.dispose();
          renderer.forceContextLoss();
          canvas.style.display = 'none';
        };

        const dismiss = () => { ending = true; };
        const evs = ['pointerdown', 'touchstart', 'mousedown', 'keydown', 'wheel'];
        const removeListeners = () => evs.forEach((e) => window.removeEventListener(e, dismiss, true));
        // capture + passive: never blocks or swallows what the person tapped
        evs.forEach((e) => window.addEventListener(e, dismiss, { capture: true, passive: true }));

        const tick = () => {
          raf = requestAnimationFrame(tick);
          const dt = Math.min(clock.getDelta(), 0.05);
          const t = clock.elapsedTime;

          if (ending) {
            fade -= dt / 0.25;
            canvas.style.opacity = String(Math.max(fade, 0));
            if (fade <= 0) { finish(); return; }
          }

          const u = Math.min(t / duration, 1);
          // gentle ease at the ends, steady through the middle
          const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
          const k = u * 0.7 + e * 0.3;

          curve.getPointAt(k, P);
          curve.getTangentAt(k, T);
          heli.position.copy(P);
          const yaw = Math.atan2(-T.z, T.x);
          heli.rotation.set(0, yaw, 0);

          // bank into turns, nose slightly down, little hover bob
          let yawRate = 0;
          if (yawPrev !== null && dt > 0) {
            let d = yaw - yawPrev;
            while (d > Math.PI) d -= 2 * Math.PI;
            while (d < -Math.PI) d += 2 * Math.PI;
            yawRate = d / dt;
          }
          yawPrev = yaw;
          bank += (THREE.MathUtils.clamp(-yawRate * 0.35, -0.5, 0.5) - bank) * Math.min(1, dt * 4);
          model.rotation.set(bank, 0, -0.08 + Math.sin(t * 2.2) * 0.02);
          model.position.y = Math.sin(t * 3.1) * 0.05;

          rotor.rotation.y += dt * 38;
          tailRotor.rotation.z += dt * 50;

          // flutter the banner: wave grows toward the free end
          for (let i = 0; i < bannerPos.count; i++) {
            const x = baseX[i];
            const along = (BW / 2 - x) / BW; // 0 at the rope, 1 at the free end
            const amp = 0.02 + along * 0.2;
            bannerPos.setZ(i, Math.sin(along * 7 - t * 9) * amp);
            bannerPos.setY(i, baseY[i] + Math.sin(along * 4 - t * 6) * amp * 0.5);
          }
          bannerPos.needsUpdate = true;

          renderer.render(scene, camera);
          if (u >= 1 && !ending) ending = true;
        };
        raf = requestAnimationFrame(tick);

        cleanup = () => { ending = true; finish(); };
      })
      .catch(() => { /* three not installed or blocked: skip the flourish */ });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);

  return <canvas ref={canvasRef} className="chopper" aria-hidden="true" />;
}
