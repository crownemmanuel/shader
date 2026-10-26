import React, { useEffect, useState } from "react";
import {
  Bookmark,
  Layers,
  Plus,
  Save,
  Play,
  Archive,
  Square,
  RotateCcw,
} from "lucide-react";
import type { Camera } from "../engine/types";
import type { Preset, RecallJob } from "../engine/presets";
import { defaultPresetControls, presetEligible } from "../engine/preset-values";
import { command } from "./api";

export function PresetLibrary({
  cameras,
  selected,
  jobs,
  perform,
}: {
  cameras: Camera[];
  selected?: string;
  jobs: RecallJob[];
  perform: Function;
}) {
  const [items, setItems] = useState<any[]>([]),
    [archived, setArchived] = useState(false),
    [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState<Preset>(),
    [preview, setPreview] = useState<any>(),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [fade, setFade] = useState(0);
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [attachLighting, setAttachLighting] = useState(true);
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  const reload = async () =>
    setItems(await command("presets_list", { includeArchived: true }));
  useEffect(() => {
    void reload().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (
      current &&
      !editing &&
      !["queued", "running"].includes(jobs[0]?.status || "")
    ) {
      let cancelled = false;
      void command("preset_preview", { presetId: current.id })
        .then((p) => {
          if (!cancelled) setPreview(p);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
      return () => {
        cancelled = true;
      };
    }
  }, [current?.id, editing, jobs[0]?.id, jobs[0]?.status]);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const create = () => {
    setCurrent(undefined);
    setPreview(undefined);
    setEditing(true);
    setName("");
    setDescription("");
    const camera = cameras.find((c) => c.id === selected) || cameras[0];
    setSelection(
      camera
        ? { [camera.id]: defaultPresetControls(camera).map((c) => c.id) }
        : {},
    );
  };
  const inspect = async (id: string) => {
    setCurrent(await command("preset_get", { presetId: id }));
    setPreview(await command("preset_preview", { presetId: id }));
    setEditing(false);
  };
  const activeJobs = jobs.filter((j) =>
    ["queued", "running"].includes(j.status),
  );
  return (
    <div className="look-panel">
      <div className="look-intro">
        <Bookmark size={24} />
        <div>
          <h3>A look worth keeping.</h3>
          <p>
            Save one camera, or bring several cameras together in a scene.
            StageLight can recall either by its stable preset ID.
          </p>
        </div>
        <button onClick={create} disabled={!cameras.length || busy}>
          <Plus size={15} />
          Save current look
        </button>
      </div>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {jobs[0]?.finishedAt && (
        <div
          role="status"
          className={
            jobs[0].status === "applied" ? "look-notice" : "look-blockers"
          }
        >
          <strong>
            {jobs[0].name} · {jobs[0].status}
          </strong>
          <p>{jobs[0].summary}</p>
        </div>
      )}
      {activeJobs.map((j) => (
        <div className="recall-progress" key={j.id}>
          <div>
            <strong>{j.name}</strong>
            <span>
              {Math.round(j.progress * 100)}% · {j.completedWrites} changes sent
            </span>
            <progress max={1} value={j.progress} />
          </div>
          <button
            onClick={() =>
              void act(async () => {
                await perform("preset_cancel", { jobId: j.id });
              })
            }
          >
            <Square size={14} />
            Stop recall
          </button>
        </div>
      ))}
      <div className="preset-layout">
        <aside className="preset-list">
          <label className="check-label">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />
            Show archived
          </label>
          {!items.filter((p) => archived || !p.archived).length && (
            <div className="look-empty">
              <Layers size={30} />
              <h3>No saved looks yet</h3>
              <p>Adjust a camera, then save its current settings here.</p>
            </div>
          )}
          {items
            .filter((p) => archived || !p.archived)
            .map((p) => (
              <div
                className={`preset-card ${current?.id === p.id ? "selected" : ""}`}
                key={p.id}
              >
                <button
                  disabled={p.archived || busy}
                  onClick={() => void act(() => inspect(p.id))}
                >
                  {p.kind === "scene" ? (
                    <Layers size={18} />
                  ) : (
                    <Bookmark size={18} />
                  )}
                  <span>
                    <strong>{p.name}</strong>
                    <small>
                      {p.archived
                        ? "Archived"
                        : `${p.cameras.length} camera${p.cameras.length === 1 ? "" : "s"}`}{" "}
                      ·{" "}
                      {p.cameras.reduce(
                        (s: number, c: any) => s + c.controls,
                        0,
                      )}{" "}
                      controls
                    </small>
                  </span>
                </button>
                {p.archived && (
                  <button
                    className="quiet"
                    onClick={() =>
                      void act(async () => {
                        await perform("preset_archive", {
                          presetId: p.id,
                          archived: false,
                        });
                        await reload();
                      })
                    }
                  >
                    <RotateCcw size={14} />
                    Restore
                  </button>
                )}
              </div>
            ))}
        </aside>
        <section className="preset-detail">
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const result = await perform("preset_save", {
                    ...(current ? { id: current.id } : {}),
                    name,
                    description,
                    attachLighting,
                    cameras: Object.entries(selection).map(
                      ([cameraId, controlIds]) => ({ cameraId, controlIds }),
                    ),
                  });
                  await reload();
                  await inspect(result.id);
                });
              }}
            >
              <h3>
                {current
                  ? "Update saved look"
                  : Object.keys(selection).length > 1
                    ? "New scene"
                    : "New camera look"}
              </h3>
              <label>
                Preset name
                <input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Warm stage · faces"
                  autoFocus
                />
              </label>
              <label>
                Notes
                <textarea
                  maxLength={500}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="When to use this look…"
                  rows={2}
                />
              </label>
              <fieldset className="look-fieldset">
                <legend>Cameras in this look</legend>
                {cameras.map((camera) => (
                  <div className="preset-camera-choice" key={camera.id}>
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={!!selection[camera.id]}
                        onChange={(e) =>
                          setSelection((s) => {
                            const next = { ...s };
                            if (e.target.checked)
                              next[camera.id] = defaultPresetControls(
                                camera,
                              ).map((c) => c.id);
                            else delete next[camera.id];
                            return next;
                          })
                        }
                      />
                      {camera.name}
                      <small>
                        {camera.vendor === "demo" ? "Simulator" : camera.model}
                      </small>
                    </label>
                    {selection[camera.id] && (
                      <details>
                        <summary>
                          {selection[camera.id].length} controls selected ·
                          choose what to save
                        </summary>
                        <div className="preset-controls">
                          {camera.controls
                            .filter(presetEligible)
                            .map((control) => (
                              <label className="check-label" key={control.id}>
                                <input
                                  type="checkbox"
                                  checked={selection[camera.id].includes(
                                    control.id,
                                  )}
                                  onChange={(e) =>
                                    setSelection((s) => ({
                                      ...s,
                                      [camera.id]: e.target.checked
                                        ? [...s[camera.id], control.id]
                                        : s[camera.id].filter(
                                            (id) => id !== control.id,
                                          ),
                                    }))
                                  }
                                />
                                <span>
                                  {control.label}
                                  <small>
                                    {JSON.stringify(control.value)} ·{" "}
                                    {control.freshness}
                                  </small>
                                </span>
                              </label>
                            ))}
                        </div>
                      </details>
                    )}
                  </div>
                ))}
              </fieldset>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={attachLighting}
                  onChange={(e) => setAttachLighting(e.target.checked)}
                />
                Remember the current lighting context
              </label>
              <p className="form-note">
                Saves current known values, including values sent but not yet
                confirmed by the camera. Focus, movement and one-shot actions
                are excluded by default.
              </p>
              <button
                className="primary"
                disabled={
                  busy ||
                  !Object.keys(selection).length ||
                  Object.values(selection).some((v) => !v.length)
                }
              >
                <Save size={15} />
                {current ? "Replace with current settings" : "Save look"}
              </button>
            </form>
          ) : current && preview ? (
            <>
              <div className="look-row">
                <div>
                  <span className="eyebrow">
                    {current.kind === "scene"
                      ? "Scene preset"
                      : "Camera preset"}
                  </span>
                  <h3>{current.name}</h3>
                </div>
                <button
                  className="quiet"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await perform("preset_archive", {
                        presetId: current.id,
                        archived: true,
                      });
                      setCurrent(undefined);
                      setPreview(undefined);
                      await reload();
                    })
                  }
                >
                  <Archive size={14} />
                  Archive
                </button>
              </div>
              <p className="muted">
                {current.description || "No notes for this look."}
              </p>
              <label>
                Stable ID for StageLight
                <input
                  readOnly
                  value={current.id}
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <div className="look-row">
                <span>{current.cameras.map((c) => c.name).join(" · ")}</span>
                <span className="state-label">
                  {current.lighting ? "Lighting attached" : "Camera settings"}
                </span>
              </div>
              <details>
                <summary>Saved values & lighting context</summary>
                <pre className="look-json">
                  {JSON.stringify(
                    { cameras: current.cameras, lighting: current.lighting },
                    null,
                    2,
                  )}
                </pre>
              </details>
              {preview.blockers.length > 0 && (
                <div className="look-blockers">
                  <strong>Before recalling</strong>
                  {preview.blockers.map((b: string) => (
                    <p key={b}>{b}</p>
                  ))}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        for (const c of current.cameras)
                          if (
                            cameras.some(
                              (camera) =>
                                camera.id === c.cameraId &&
                                camera.vendor !== "demo",
                            )
                          )
                            await perform("camera_unlock", {
                              cameraId: c.cameraId,
                            });
                        setPreview(
                          await command("preset_preview", {
                            presetId: current.id,
                          }),
                        );
                      })
                    }
                  >
                    Unlock these cameras
                  </button>
                </div>
              )}
              <div className="look-row">
                <h4>{preview.changes.length} changes in this recall</h4>
                <button
                  className="quiet"
                  disabled={busy}
                  onClick={() =>
                    void act(async () =>
                      setPreview(
                        await command("preset_preview", {
                          presetId: current.id,
                        }),
                      ),
                    )
                  }
                >
                  Refresh preview
                </button>
              </div>
              <div className="preset-changes">
                <table>
                  <thead>
                    <tr>
                      <th>Camera / control</th>
                      <th>Now</th>
                      <th>Saved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.changes.map((c: any) => (
                      <tr key={`${c.cameraId}:${c.controlId}`}>
                        <td>
                          {c.label}
                          <small>{c.camera}</small>
                        </td>
                        <td>{JSON.stringify(c.from)}</td>
                        <td>{JSON.stringify(c.to)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <label>
                Transition · {fade}s
                <input
                  aria-label="Preset transition seconds"
                  type="range"
                  min={0}
                  max={30}
                  step={0.5}
                  value={fade}
                  onChange={(e) => setFade(Number(e.target.value))}
                />
              </label>
              <p className="form-note">
                Color and supported exposure controls fade smoothly. Shutter and
                other discrete values change at the end. A camera rejection
                stops remaining writes.
              </p>
              <div className="look-row">
                <button
                  className="primary"
                  disabled={
                    busy || !!preview.blockers.length || !!activeJobs.length
                  }
                  onClick={() =>
                    void act(async () => {
                      await perform("preset_recall", {
                        presetId: current.id,
                        expectedRevisions: preview.revisions,
                        fade,
                      });
                    })
                  }
                >
                  <Play size={15} />
                  Recall {current.kind === "scene" ? "scene" : "look"}
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setEditing(true);
                    setName(current.name);
                    setDescription(current.description);
                    setSelection(
                      Object.fromEntries(
                        current.cameras.map((c) => [
                          c.cameraId,
                          c.controls.map((p) => p.id),
                        ]),
                      ),
                    );
                  }}
                >
                  Update from current cameras
                </button>
              </div>
            </>
          ) : (
            <div className="look-empty">
              <Bookmark size={36} />
              <h3>One look. Every camera.</h3>
              <p>
                Select a preset to see exactly what it will change, or save your
                current camera settings.
              </p>
            </div>
          )}
        </section>
      </div>
      {!!jobs.length && (
        <details>
          <summary>Recent recalls</summary>
          {jobs.slice(0, 8).map((j) => (
            <div className="look-event" key={j.id}>
              <strong>
                {j.name} · {j.status}
              </strong>
              <span>{j.summary}</span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
