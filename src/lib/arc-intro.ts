export const INTRO_SEEN_KEY = "mw_arc_intro_seen_v1";
export const REPLAY_INTRO_EVENT = "mw:replay-intro";

export function replayArcIntro() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(REPLAY_INTRO_EVENT));
}
