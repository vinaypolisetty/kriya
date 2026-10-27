/**
 * Mark an area on an image by dragging (Day 25): for a crop, the area to keep;
 * for an edit, the only part to change. The area is fractions of the image
 * itself (`x,y,w,h`), not of the box around it, so a letterboxed preview
 * still marks the right pixels. Typing the numbers works too.
 */
import { useEffect, useReducer, useRef, useState, type PointerEvent } from "react";

type Box = { x: number; y: number; w: number; h: number };

/** Where the picture is drawn inside an <img> with object-fit: contain. */
function drawn(img: HTMLImageElement): DOMRect {
  const r = img.getBoundingClientRect();
  const ar = img.naturalWidth / img.naturalHeight || r.width / r.height;
  const w = Math.min(r.width, r.height * ar);
  const h = w / ar;
  return new DOMRect(r.left + (r.width - w) / 2, r.top + (r.height - h) / 2, w, h);
}

export const parseRegion = (s: string): Box | undefined => {
  const r = s.split(",").map(Number);
  if (r.length !== 4 || r.some((n) => !Number.isFinite(n) || n < 0 || n > 1) || r[2] === 0 || r[3] === 0) return undefined;
  const [x, y, w, h] = r as [number, number, number, number];
  return { x, y, w, h };
};
const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;

export function Region({ src, alt, value, onChange }: { src: string; alt: string; value: string; onChange: (region: string) => void }) {
  const img = useRef<HTMLImageElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<{ x: number; y: number }>();
  const box = parseRegion(value);
  // Where the mark goes depends on the picture's drawn size: measure again when it loads or the window changes.
  const [, remeasure] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    addEventListener("resize", remeasure);
    return () => removeEventListener("resize", remeasure);
  }, []);

  const at = (e: PointerEvent) => {
    const r = drawn(img.current!);
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const down = (e: PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    setStart(at(e));
  };
  const move = (e: PointerEvent) => {
    if (!start) return;
    const p = at(e);
    const x = round(Math.min(start.x, p.x));
    const y = round(Math.min(start.y, p.y));
    onChange(`${x},${y},${round(Math.abs(p.x - start.x))},${round(Math.abs(p.y - start.y))}`);
  };
  const up = () => setStart(undefined);

  // The overlay sits on the drawn picture, in the container's coordinates.
  const overlay = (() => {
    if (!box || !img.current || !holder.current || !img.current.complete) return undefined;
    const frame = holder.current.getBoundingClientRect();
    const r = drawn(img.current);
    return { left: r.left - frame.left + box.x * r.width, top: r.top - frame.top + box.y * r.height, width: box.w * r.width, height: box.h * r.height };
  })();

  return (
    <div className="region" ref={holder} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <img ref={img} src={src} alt={alt} draggable={false} onLoad={remeasure} />
      {overlay && <span className="mark" style={overlay} aria-hidden="true" />}
    </div>
  );
}
