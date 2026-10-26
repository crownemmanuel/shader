// SEA cannot resolve atem-connection's runtime worker path. This explicit in-process
// adapter uses its unmodified UDP transport, including ACK/retransmit/reconnect.
import { AtemSocketChild } from "atem-connection/dist/lib/atemSocketChild.js";
export async function threadedClass(
  _path: string,
  name: string,
  args: unknown[],
  options: any,
) {
  if (name !== "AtemSocketChild" || !options.disableMultithreading)
    throw new Error("Only in-process ATEM transport is supported");
  return new (AtemSocketChild as any)(...args);
}
export const ThreadedClassManager = {
  destroy: async (instance: AtemSocketChild) => instance.disconnect(),
  onEvent: () => () => {},
};
