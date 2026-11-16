// Picture + Ask Karo side by side (Gorn 11-16: "so i can view it and talk to you").
// ChatImage announces which picture is open; AskKaro listens, so on a wide screen
// the chat docks beside the picture instead of hiding under it. Window events,
// the same pattern as REFRESH_EVENT: no shared store, no new dependency.
export const IMAGE_VIEW_EVENT = 'study-image-view';
export const ASK_OPEN_EVENT = 'study-ask-open';

export interface ImageView { alt: string | null }

let current: string | null = null;
export function viewingImage(): string | null { return current; }
export function announceImage(alt: string | null) {
  current = alt;
  window.dispatchEvent(new CustomEvent<ImageView>(IMAGE_VIEW_EVENT, { detail: { alt } }));
}
export function openAskKaro() { window.dispatchEvent(new Event(ASK_OPEN_EVENT)); }

// The alt rides inside the "[Study: …]" context header, which CTX_RE caps at 200
// chars and ends at "]" or a newline, so strip both and keep it short.
export function pictureLabel(alt: string): string {
  const clean = alt.replace(/[\]\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}
