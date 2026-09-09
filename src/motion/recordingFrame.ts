export interface RecordingFrameOptions {
  caption: string;
  selectionLabel?: string;
  selectionPath?: string;
  selectionValue?: string | number;
  origin?: string;
}

const SIZE = 1080;
const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const clean = (text = "") => text.replace(/\s+/g, " ").trim();

function ellipsis(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number,
  keepEnd = false,
) {
  if (ctx.measureText(text).width <= width) return text;
  const letters = Array.from(text);
  while (letters.length) {
    if (keepEnd) letters.shift();
    else letters.pop();
    const result = keepEnd ? `…${letters.join("")}` : `${letters.join("")}…`;
    if (ctx.measureText(result).width <= width) return result;
  }
  return "…";
}

function captionLines(ctx: CanvasRenderingContext2D, caption: string) {
  const width = 1000;
  const words = clean(caption).split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= width) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = "";
    // Even an unbroken URL or a very long word stays inside the image.
    for (const letter of Array.from(word)) {
      if (ctx.measureText(line + letter).width > width && line) {
        lines.push(line);
        line = "";
      }
      line += letter;
    }
  }
  if (line) lines.push(line);
  if (lines.length > 3) {
    lines[2] = ellipsis(ctx, `${lines[2]} ${lines.slice(3).join(" ")}`, width);
    lines.length = 3;
  }
  return lines;
}

/** Composite the actual stage and current controls into a square video frame. */
export function drawRecordingFrame(
  ctx: CanvasRenderingContext2D,
  sourceCanvas: HTMLCanvasElement,
  options: RecordingFrameOptions,
) {
  ctx.save();
  ctx.setTransform(ctx.canvas.width / SIZE, 0, 0, ctx.canvas.height / SIZE, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#12121a";
  ctx.fillRect(0, 0, SIZE, SIZE);

  ctx.fillStyle = "#c4b5fd";
  ctx.font = `700 25px ${FONT}`;
  ctx.fillText("PAW", 40, 24);
  ctx.fillStyle = "#777382";
  ctx.font = `400 24px ${FONT}`;
  ctx.fillText("/", 112, 24);
  ctx.fillStyle = "#efedf7";
  ctx.font = `500 24px ${FONT}`;
  ctx.fillText("Avatar Director", 136, 24);
  if (options.origin) {
    ctx.font = `400 21px ${FONT}`;
    ctx.fillStyle = "#a6a1b3";
    ctx.textAlign = "right";
    ctx.fillText(ellipsis(ctx, clean(options.origin), 430), 1040, 27);
    ctx.textAlign = "left";
  }

  const selectionLabel = clean(options.selectionLabel);
  const stageHeight = selectionLabel ? 784 : 844;
  if (sourceCanvas.width > 0 && sourceCanvas.height > 0) {
    const scale = Math.min(
      SIZE / sourceCanvas.width,
      stageHeight / sourceCanvas.height,
    );
    const width = sourceCanvas.width * scale;
    const height = sourceCanvas.height * scale;
    // Contain preserves fingertips, coin, and full-body poses at every aspect ratio.
    ctx.drawImage(
      sourceCanvas,
      (SIZE - width) / 2,
      72 + (stageHeight - height) / 2,
      width,
      height,
    );
  }

  if (selectionLabel) {
    ctx.fillStyle = "#a78bfa";
    ctx.fillRect(40, 869, 3, 48);
    const value =
      options.selectionValue == null ? "" : clean(String(options.selectionValue));
    ctx.font = `600 28px ${FONT}`;
    const valueWidth = Math.min(ctx.measureText(value).width, 240);
    ctx.fillStyle = "#ddd2ff";
    ctx.textAlign = "right";
    ctx.fillText(ellipsis(ctx, value, 240), 1040, 867);
    ctx.textAlign = "left";
    ctx.fillStyle = "#efedf7";
    ctx.font = `500 27px ${FONT}`;
    ctx.fillText(
      ellipsis(ctx, selectionLabel, 956 - valueWidth - (value ? 32 : 0)),
      58,
      867,
    );
    const path = clean(options.selectionPath);
    if (path && path !== selectionLabel) {
      ctx.font = `400 20px ${FONT}`;
      ctx.fillStyle = "#aaa3ba";
      ctx.fillText(ellipsis(ctx, path, 982, true), 58, 901);
    }
  }

  ctx.fillStyle = "#34303f";
  ctx.fillRect(40, 932, 1000, 1);
  ctx.fillStyle = "#ffffff";
  ctx.font = `500 36px ${FONT}`;
  captionLines(ctx, options.caption).forEach((line, index) => {
    ctx.fillText(line, 40, 949 + index * 43);
  });
  ctx.restore();
}
