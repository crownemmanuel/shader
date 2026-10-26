import { listVisibleInputs, type AtemState } from "atem-connection";
import type { Camera } from "./types.js";
export interface TallyRoute {
  host: string;
  input: number;
  me: number;
}
export interface SwitcherInfo {
  host: string;
  name: string;
  connected: boolean;
  inputs: { id: number; name: string }[];
  buses: { me: number; program: number[]; preview: number[]; known: boolean }[];
}
export function switcherInfo(
  host: string,
  state: AtemState | undefined,
  connected: boolean,
): SwitcherInfo {
  return {
    host,
    name: state?.info.productIdentifier || "ATEM",
    connected,
    inputs: Object.values(state?.inputs || {}).flatMap((i) =>
      i ? [{ id: i.inputId, name: i.longName }] : [],
    ),
    buses: (state?.video.mixEffects || []).flatMap((me, i) => {
      if (!me) return [];
      try {
        return [
          {
            me: i,
            program: listVisibleInputs("program", state!, i),
            preview: listVisibleInputs("preview", state!, i),
            known: connected,
          },
        ];
      } catch {
        return [{ me: i, program: [], preview: [], known: false }];
      }
    }),
  };
}
export function routedTally(
  route: TallyRoute | undefined,
  switchers: SwitcherInfo[],
): Camera["tally"] {
  if (!route) return "unknown";
  const sw = switchers.find((s) => s.host === route.host),
    bus = sw?.buses.find((b) => b.me === route.me);
  if (
    !sw?.connected ||
    !bus?.known ||
    !sw.inputs.some((i) => i.id === route.input)
  )
    return "unknown";
  return bus.program.includes(route.input)
    ? "program"
    : bus.preview.includes(route.input)
      ? "preview"
      : "off";
}
