import { useEffect, useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { command } from "./api";
import { updateInstallBlocker } from "../engine/update-safety";

type State = {
  current: string;
  phase:
    | "idle"
    | "checking"
    | "current"
    | "available"
    | "downloading"
    | "ready"
    | "installing"
    | "error";
  version?: string;
  notes?: string;
  error?: string;
  done: number;
  total: number;
};
let state: State = { current: "", phase: "idle", done: 0, total: 0 };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
let pending: Update | null = null;
let downloaded = false;
let checking: Promise<void> | null = null;

export async function checkForUpdate(quiet = false): Promise<void> {
  if (!isTauri() || ["downloading", "installing"].includes(state.phase)) return;
  if (checking) return checking;
  if (!quiet) set({ phase: "checking", error: undefined });
  checking = (async () => {
    try {
      const current = await getVersion();
      const update = await check({ timeout: 30_000 });
      if (pending && downloaded && update?.version === pending.version) {
        await update.close();
      } else {
        await pending?.close();
        pending = update;
        downloaded = false;
      }
      set({
        current,
        phase: pending ? (downloaded ? "ready" : "available") : "current",
        version: pending?.version,
        notes: pending?.body,
        error: undefined,
      });
    } catch (error) {
      if (!quiet) set({ phase: "error", error: String(error) });
    } finally {
      checking = null;
    }
  })();
  return checking;
}

// Updating restarts the camera engine. Never interrupt armed writes or an active recall.
export async function updateBlocker(): Promise<string | null> {
  return updateInstallBlocker(await command("system_status"));
}

async function installUpdate(version: string) {
  if (import.meta.env.DEV)
    throw new Error(
      "Development builds update from git. Install a release to use app updates.",
    );
  if (!pending || pending.version !== version)
    throw new Error("The available version changed. Check again.");
  if (["checking", "downloading", "installing"].includes(state.phase)) return;
  const update = pending;
  set({ phase: "downloading", error: undefined, done: 0, total: 0 });
  try {
    const blocker = await updateBlocker();
    if (blocker) throw new Error(blocker);
    if (!downloaded) {
      await update.download((event) => {
        if (event.event === "Started")
          set({ total: event.data.contentLength ?? 0 });
        if (event.event === "Progress")
          set({ done: state.done + event.data.chunkLength });
      });
      downloaded = true;
    }
    const lateBlocker = await updateBlocker();
    if (lateBlocker) throw new Error(lateBlocker);
    set({ phase: "installing" });
    await update.install();
    await relaunch();
  } catch (error) {
    set({ phase: "error", error: String(error) });
  }
}

export function useUpdateChecks() {
  const value = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (!isTauri() || import.meta.env.DEV) return;
    const first = setTimeout(() => void checkForUpdate(true), 20_000);
    const interval = setInterval(() => void checkForUpdate(true), 6 * 3600_000);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, []);
  return value;
}

export function AppUpdates() {
  const value = useSyncExternalStore(subscribe, () => state);
  const busy = ["checking", "downloading", "installing"].includes(value.phase);
  if (!isTauri())
    return (
      <section>
        <h3>App updates</h3>
        <p>Updates are available in the Shader desktop app.</p>
      </section>
    );
  return (
    <section className="settings-section" aria-label="App updates">
      <h3>App updates{value.current ? ` · ${value.current}` : ""}</h3>
      <p>
        Shader checks for signed releases automatically. Installing restarts the
        app and camera connections.
      </p>
      <div role="status" aria-live="polite">
        {value.phase === "checking" && <p>Checking for updates…</p>}
        {value.phase === "current" && <p>You’re running the latest version.</p>}
        {value.version && <p>Version {value.version} is available.</p>}
        {value.notes && (
          <pre
            style={{ whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}
          >
            {value.notes}
          </pre>
        )}
        {value.phase === "downloading" && (
          <>
            <progress
              max={value.total || undefined}
              value={value.total ? value.done : undefined}
              aria-label="Update download"
            />
            <p>Downloading {(value.done / 1048576).toFixed(1)} MB…</p>
          </>
        )}
        {value.phase === "installing" && (
          <p>Installing and restarting Shader…</p>
        )}
        {value.error && <p role="alert">{value.error}</p>}
      </div>
      <button disabled={busy} onClick={() => void checkForUpdate()}>
        Check for updates
      </button>{" "}
      {value.version && (
        <button
          disabled={busy || import.meta.env.DEV}
          onClick={() =>
            void installUpdate(value.version!).catch((error) =>
              set({ phase: "error", error: String(error) }),
            )
          }
        >
          Install {value.version} and restart
        </button>
      )}
    </section>
  );
}
