// The study chat's peer and message shape, in a plain .ts module with no React import, so
// pure helpers (drillParse.ts) can use them and still load in the backend test runner,
// which has no frontend node_modules (PR 150 CI, 11-16).

export const PEER = 'karo';

// Who a guest's study chat goes to (Gorn 11-17: "let Gnarl be main mentor for guests").
export const GUEST_MENTOR = 'gnarl';

export interface Msg {
  id: number;
  sender: string;
  message: string;
  created_at: string;
}

// One study chat: who it talks to and which endpoints carry it.
//   owner → the gorn ↔ karo DM thread, owner DM routes, pins on.
//   guest → that guest ↔ gnarl, the guest DM routes (rate limits, length caps and
//           the injection scan already live there), no pins.
// storePrefix keeps each person's browser-side caches (drafts, verdicts, seen badge)
// apart if two people ever use the same browser.
export interface StudyChannel {
  peer: string;
  name: string;
  threadUrl: string;
  sendUrl: string;
  markReadUrl: string | null;
  storePrefix: string;
  pins: boolean;
}

export const OWNER_CHANNEL: StudyChannel = {
  peer: PEER,
  name: 'Karo',
  threadUrl: `/api/dm/gorn/${PEER}?limit=40&order=desc`,
  sendUrl: '/api/dm',
  markReadUrl: `/api/dm/gorn/${PEER}/read`,
  storePrefix: '',
  pins: true,
};

export function guestChannel(username: string): StudyChannel {
  const u = encodeURIComponent(username);
  return {
    peer: GUEST_MENTOR,
    name: 'Gnarl',
    threadUrl: `/api/guest/dm/${u}/${GUEST_MENTOR}?limit=40&order=desc`,
    sendUrl: '/api/guest/dm',
    markReadUrl: null,
    storePrefix: `guest:${username}:`,
    pins: false,
  };
}
