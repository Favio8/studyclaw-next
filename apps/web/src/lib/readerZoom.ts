export type ReaderZoom = "width" | "page" | number;

export function readerScale(zoom: ReaderZoom, width: number, height: number, pageWidth: number, pageHeight: number): number {
  if (typeof zoom === "number") return zoom;
  const fitWidth = Math.max(0.1, (width - 32) / pageWidth);
  return zoom === "width" ? fitWidth : Math.max(0.1, Math.min(fitWidth, (height - 32) / pageHeight));
}

export function stepZoom(scale: number, direction: number): number {
  return Math.max(0.25, Math.min(4, Math.round((scale + direction * 0.25) * 100) / 100));
}

export function isReaderEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || !!target.closest("input, textarea, select, [role=dialog]"));
}
