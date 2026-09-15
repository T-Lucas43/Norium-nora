type CaptureCanvas = HTMLCanvasElement & {
  captureStream(frameRate?: number): MediaStream;
};

export type BackgroundBlurPipeline = {
  sourceTrack: MediaStreamTrack;
  outputTrack: MediaStreamTrack;
  stop: (stopSource?: boolean) => void;
};

export function supportsCanvasBackgroundBlur() {
  return typeof document !== "undefined"
    && typeof HTMLCanvasElement !== "undefined"
    && typeof (HTMLCanvasElement.prototype as CaptureCanvas).captureStream === "function"
    && typeof requestAnimationFrame === "function";
}

function drawCover(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
  overscan = 1,
) {
  const sourceWidth = video.videoWidth || width;
  const sourceHeight = video.videoHeight || height;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = width / height;
  let cropWidth = sourceWidth;
  let cropHeight = sourceHeight;
  let cropX = 0;
  let cropY = 0;
  if (sourceRatio > targetRatio) {
    cropWidth = sourceHeight * targetRatio;
    cropX = (sourceWidth - cropWidth) / 2;
  } else if (sourceRatio < targetRatio) {
    cropHeight = sourceWidth / targetRatio;
    cropY = (sourceHeight - cropHeight) / 2;
  }
  const drawWidth = width * overscan;
  const drawHeight = height * overscan;
  context.drawImage(
    video,
    cropX,
    cropY,
    cropWidth,
    cropHeight,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

/**
 * Produces a real camera track with a softly blurred background. Native camera
 * blur is preferred by the caller; this canvas pipeline is the browser-safe
 * fallback and is also what peers receive through WebRTC.
 */
export async function createCanvasBackgroundBlur(sourceTrack: MediaStreamTrack): Promise<BackgroundBlurPipeline> {
  if (!supportsCanvasBackgroundBlur()) throw new Error("Processamento de fundo indisponível neste navegador.");

  const settings = sourceTrack.getSettings?.() || {};
  const width = Math.max(640, Number(settings.width) || 1280);
  const height = Math.max(360, Number(settings.height) || 720);
  const video = document.createElement("video");
  const canvas = document.createElement("canvas") as CaptureCanvas;
  const foreground = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  const foregroundContext = foreground.getContext("2d");
  if (!context || !foregroundContext) throw new Error("O navegador não iniciou o processador de fundo.");

  canvas.width = width;
  canvas.height = height;
  foreground.width = width;
  foreground.height = height;
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([sourceTrack]);
  await video.play();

  const outputStream = canvas.captureStream(24);
  const outputTrack = outputStream.getVideoTracks()[0];
  if (!outputTrack) {
    video.pause();
    video.srcObject = null;
    throw new Error("O navegador não criou o vídeo com fundo desfocado.");
  }
  if ("contentHint" in outputTrack) outputTrack.contentHint = "motion";

  let stopped = false;
  let animationFrame = 0;
  let lastFrameAt = 0;
  const stop = (stopSource = false) => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(animationFrame);
    sourceTrack.removeEventListener("ended", handleSourceEnded);
    outputTrack.stop();
    video.pause();
    video.srcObject = null;
    if (stopSource) sourceTrack.stop();
  };
  const handleSourceEnded = () => stop();
  sourceTrack.addEventListener("ended", handleSourceEnded, { once: true });
  const render = (now: number) => {
    if (stopped) return;
    animationFrame = requestAnimationFrame(render);
    if (video.readyState < 2 || now - lastFrameAt < 1000 / 24) return;
    lastFrameAt = now;

    context.save();
    context.clearRect(0, 0, width, height);
    context.filter = "blur(22px) saturate(.94)";
    drawCover(context, video, width, height, 1.08);
    context.restore();

    foregroundContext.save();
    foregroundContext.setTransform(1, 0, 0, 1, 0, 0);
    foregroundContext.clearRect(0, 0, width, height);
    foregroundContext.globalCompositeOperation = "source-over";
    drawCover(foregroundContext, video, width, height);
    foregroundContext.globalCompositeOperation = "destination-in";
    foregroundContext.translate(width / 2, height * .47);
    foregroundContext.scale(1, 1.3);
    const mask = foregroundContext.createRadialGradient(0, 0, width * .18, 0, 0, width * .43);
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(.68, "rgba(0,0,0,.98)");
    mask.addColorStop(.9, "rgba(0,0,0,.72)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    foregroundContext.fillStyle = mask;
    foregroundContext.fillRect(-width / 2, -height / 2, width, height);
    foregroundContext.restore();

    context.drawImage(foreground, 0, 0);
  };
  animationFrame = requestAnimationFrame(render);

  return {
    sourceTrack,
    outputTrack,
    stop,
  };
}
