import { useAuth } from '../contexts/AuthContext';
import { OWNER_CHANNEL, guestChannel, type StudyChannel } from './studyPeer';

// The study chat for whoever is looking: the owner talks to Karo, a guest with Study
// switched on talks to their mentor (Gnarl). Anyone else gets no chat at all.
export function useStudyChannel(): StudyChannel | null {
  const { isGuest, studyEnabled, guestUsername } = useAuth();
  if (!isGuest) return OWNER_CHANNEL;
  if (studyEnabled && guestUsername) return guestChannel(guestUsername);
  return null;
}
