"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/src/lib/api";
import { readerScale, stepZoom, type ReaderZoom } from "@/src/lib/readerZoom";

export default function ImageCanvas({ source, zoom, onScale, onZoom }: { source: string; zoom: ReaderZoom; onScale: (scale: number) => void; onZoom: (zoom: ReaderZoom) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<{ url: string; width: number; height: number } | null>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  useEffect(() => {
    let alive = true;
    let url = "";
    void api.readingFileBytes(source).then(async (bytes) => {
      if (!alive) return;
      url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
      if (alive) setImage({ url, width: bitmap.width, height: bitmap.height });
      bitmap.close();
    }).catch((exc) => { if (alive) setError(String(exc)); });
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [source]);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => { if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height }); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const scale = image ? readerScale(zoom, size.width, size.height, image.width, image.height) : 1;
  useEffect(() => { onScale(scale); }, [scale, onScale]);
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      onZoom(stepZoom(scale, event.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [onZoom, scale]);
  return <div ref={container} data-testid="image-reader" className="min-h-0 flex-1 overflow-auto bg-bg-root p-4" onPointerDown={(event) => {
    if (!image || !container.current) return;
    const el = container.current;
    drag.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(event.pointerId);
  }} onPointerMove={(event) => {
    if (!drag.current || !container.current) return;
    container.current.scrollLeft = drag.current.left - event.clientX + drag.current.x;
    container.current.scrollTop = drag.current.top - event.clientY + drag.current.y;
  }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
    {error ? <p role="alert">{error}</p> : image ? <div className="flex w-max min-w-full justify-center">
      {/* Original local image bytes; Next image optimization is unavailable in the static Host. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={image.url} alt={source} draggable={false} style={{ width: image.width * scale, height: image.height * scale, maxWidth: "none" }} className="cursor-grab touch-none select-none shadow-lv2" />
    </div> : <p>正在打开图片…</p>}
  </div>;
}
