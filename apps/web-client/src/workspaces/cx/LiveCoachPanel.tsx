// Compatibility seam for the in-call coach client.
// The legacy implementation stays available while the new coach surface is wired in.
export {
  COACH_CHAT_SLOT_ID,
  LiveCoachPanel,
  LiveCoachPanel as LegacyLiveCoachPanel,
} from "./legacy/LegacyLiveCoachPanel";
