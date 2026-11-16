// Message time for chat bubbles. Today shows just the time; older messages
// carry the day too, so a scrolled-back message says WHEN it was (Gorn,
// 2026-11-16: "sometimes when i read old messages i wonder when was it").
//   today        10:24 AM
//   yesterday    Yesterday, 10:24 AM
//   last 6 days  Mon, 10:24 AM
//   this year    Nov 14, 10:24 AM
//   older        Nov 14, 2025, 10:24 AM
export function chatTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = 86400000;
  if (d >= today) return time;
  if (d >= new Date(today.getTime() - day)) return `Yesterday, ${time}`;
  if (d >= new Date(today.getTime() - 6 * day)) return `${d.toLocaleDateString('en-US', { weekday: 'short' })}, ${time}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  return `${date}, ${time}`;
}

// Full date and time for the hover tooltip.
export function chatTimeFull(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
