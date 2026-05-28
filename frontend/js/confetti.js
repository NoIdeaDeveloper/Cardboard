let _confettiCanvas = null;
let _confettiRafId = null;

function launchConfetti() {
  if (_confettiRafId) { cancelAnimationFrame(_confettiRafId); _confettiRafId = null; }
  if (_confettiCanvas) { _confettiCanvas.remove(); _confettiCanvas = null; }

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;pointer-events:none';
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  _confettiCanvas = canvas;

  const ctx = canvas.getContext('2d');
  const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c'];
  const particles = Array.from({ length: 120 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height * -0.5,
    w: 6 + Math.random() * 8,
    h: 4 + Math.random() * 6,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    vx: (Math.random() - 0.5) * 4,
    vy: 2 + Math.random() * 5,
    angle: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 0.3,
    alpha: 1,
  }));

  const start = performance.now();
  const DURATION = 3000;

  function draw(now) {
    const elapsed = now - start;
    const progress = elapsed / DURATION;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.08;
      p.angle += p.spin;
      if (progress > 0.7) p.alpha = Math.max(0, 1 - (progress - 0.7) / 0.3);
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (elapsed < DURATION) {
      _confettiRafId = requestAnimationFrame(draw);
    } else {
      _confettiCanvas = null;
      _confettiRafId = null;
      canvas.remove();
    }
  }

  _confettiRafId = requestAnimationFrame(draw);
}
