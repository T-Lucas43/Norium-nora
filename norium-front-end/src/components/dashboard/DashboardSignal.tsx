import { useEffect, useRef } from "react";

export default function DashboardSignal() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animationFrame = 0;
    let lastFrame = 0;

    const draw = (elapsed = 0) => {
      const bounds = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width));
      const height = Math.max(1, Math.round(bounds.height));

      if (canvas.width !== Math.round(width * pixelRatio) || canvas.height !== Math.round(height * pixelRatio)) {
        canvas.width = Math.round(width * pixelRatio);
        canvas.height = Math.round(height * pixelRatio);
      }

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      const phase = reduceMotion.matches ? 0.8 : elapsed * 0.00042;
      const gradient = context.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "rgba(39, 130, 255, 0)");
      gradient.addColorStop(0.1, "rgba(39, 130, 255, 0.96)");
      gradient.addColorStop(0.56, "rgba(39, 130, 255, 1)");
      gradient.addColorStop(0.84, "rgba(39, 130, 255, 0.82)");
      gradient.addColorStop(1, "rgba(39, 130, 255, 0)");

      context.lineCap = "round";
      context.setLineDash([1.4, 4]);
      context.shadowBlur = 9;
      context.shadowColor = "rgba(39, 130, 255, 0.5)";
      context.globalCompositeOperation = "lighter";

      for (let line = 0; line < 15; line += 1) {
        const offset = line - 7;
        const amplitude = 30 + Math.abs(offset) * 2.2;
        const linePhase = phase + line * 0.27;
        const startX = Math.max(12, width * 0.02);
        const endX = Math.max(startX + 1, width - Math.max(26, width * 0.055));
        const drawableWidth = endX - startX;

        context.beginPath();
        for (let x = startX; x <= endX; x += 4) {
          const progress = (x - startX) / drawableWidth;
          const envelope = Math.sin(Math.PI * Math.min(1, Math.max(0, progress))) ** 0.72;
          const baseY = height * 0.5 + offset * 7 * envelope;
          const primaryWave = Math.sin(progress * Math.PI * 2.2 + linePhase) * amplitude;
          const secondaryWave = Math.sin(progress * Math.PI * 4.1 - linePhase * 0.72) * 4.5;
          const y = baseY + (primaryWave + secondaryWave) * envelope;

          if (x === startX) context.moveTo(x, y);
          else context.lineTo(x, y);
        }

        context.globalAlpha = 0.82 + (1 - Math.abs(offset) / 9) * 0.18;
        context.strokeStyle = gradient;
        context.lineWidth = line === 7 ? 1.5 : 1;
        context.stroke();
      }

      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
      context.shadowBlur = 0;
      context.setLineDash([]);
    };

    const animate = (elapsed: number) => {
      if (elapsed - lastFrame >= 30 || reduceMotion.matches) {
        draw(elapsed);
        lastFrame = elapsed;
      }
      if (!reduceMotion.matches) animationFrame = window.requestAnimationFrame(animate);
    };

    const handleMotionPreference = () => {
      window.cancelAnimationFrame(animationFrame);
      draw(performance.now());
      if (!reduceMotion.matches) animationFrame = window.requestAnimationFrame(animate);
    };

    const resizeObserver = new ResizeObserver(() => draw(performance.now()));
    resizeObserver.observe(canvas);
    reduceMotion.addEventListener("change", handleMotionPreference);

    draw(performance.now());
    if (!reduceMotion.matches) animationFrame = window.requestAnimationFrame(animate);

    return () => {
      resizeObserver.disconnect();
      reduceMotion.removeEventListener("change", handleMotionPreference);
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  return (
    <div className="norium-dashboard-signal" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
