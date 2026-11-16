// The study chat's peer and message shape, in a plain .ts module with no React import, so
// pure helpers (drillParse.ts) can use them and still load in the backend test runner,
// which has no frontend node_modules (PR 150 CI, 11-16).

export const PEER = 'karo';

export interface Msg {
  id: number;
  sender: string;
  message: string;
  created_at: string;
}
