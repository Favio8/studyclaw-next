/** Repair observed model emphasis padding for display; code stays literal. */
export function normalizeModelMarkdown(content: string): string {
  let fence: string | null = null;
  return content.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      return line;
    }
    if (fence !== null) return line;
    if (/^(?: {4}|\t)/.test(line)) return line;
    return line.replace(/(`+)(.*?)(?:\1|$)|(?<!\\)\*\*([^*\n]+)\*\*/g, (match, ticks: string | undefined, _code: string | undefined, bold: string | undefined) => {
      if (ticks || !bold?.trim()) return match;
      return `**${bold.trim()}**`;
    });
  }).join("\n");
}
