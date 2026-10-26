import React, { useEffect, useState } from "react";
import {
  Lightbulb,
  Radio,
  ArrowDownToLine,
  Link2,
  Plus,
  Trash2,
  Copy,
} from "lucide-react";
import type {
  LightingConfig,
  LightingRule,
  LookMessage,
} from "../engine/lighting-types";
import { command } from "./api";
export function LightingPanel({
  state,
  presets,
  perform,
}: {
  state: any;
  presets: any[];
  perform: Function;
}) {
  const [tab, setTab] = useState<"live" | "connection" | "rules">("live"),
    [settings, setSettings] = useState<any>();
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<LightingConfig>(),
    [senders, setSenders] = useState("");
  const [selectedTarget, setSelectedTarget] = useState("");
  const [rule, setRule] = useState<LightingRule>({
    name: "",
    enabled: true,
    presetId: "",
    cueName: "",
  });
  const reload = async (loadConfig = false) => {
    const s = await command("lighting_settings");
    setSettings(s);
    if (loadConfig) {
      setConfig(s.config);
      setSenders(s.config.allowedSenders.join(", "));
    }
  };
  useEffect(() => {
    void reload(true).catch((e) => setError(e.message));
  }, []);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const states: any[] = state?.states || [];
  const received =
    states.find(
      (s) => `${s.peer}|${s.message.target || "default"}` === selectedTarget,
    ) || states.at(-1);
  const look: LookMessage | undefined = received?.message;
  const analysis = received?.analysis;
  const set = (field: keyof LightingConfig, value: unknown) =>
    setConfig((c) => ({ ...c!, [field]: value }));
  return (
    <div className="look-panel">
      <div className="look-intro">
        <Lightbulb size={26} />
        <div>
          <h3>Light sets the scene.</h3>
          <p>
            Receive the stage look, recall a camera preset, or give your
            assistant the lighting context it needs.
          </p>
        </div>
        <span className={`state-label ${state?.listening ? "linked" : ""}`}>
          {state?.listening ? "Listening" : "Receiver off"}
        </span>
      </div>
      <div
        className="look-tabs"
        role="tablist"
        aria-label="Lighting link views"
      >
        {(
          [
            ["live", "Lighting now"],
            ["rules", "Cue mappings"],
            ["connection", "Connection"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="look-notice">
          {notice}
        </p>
      )}
      {state?.error && <div className="banner error">{state.error}</div>}
      {tab === "live" && (
        <section aria-label="Received lighting">
          <div className="look-row">
            <span className="muted">
              {state?.automation
                ? "Linked preset recalls enabled"
                : "Observe only · automatic recalls off"}
            </span>
            <div className="look-actions">
              <button
                disabled={!state?.listening || busy}
                onClick={() =>
                  void act(async () => {
                    await perform("lighting_request");
                    setNotice(
                      "Requested the current look from StageLight. Waiting for its reply.",
                    );
                  })
                }
              >
                <ArrowDownToLine size={15} />
                Request current look
              </button>
              <button
                className="quiet"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await perform("lighting_test");
                    setSelectedTarget("127.0.0.1|local-example");
                  })
                }
              >
                Show example
              </button>
            </div>
          </div>
          {states.length > 1 && (
            <label>
              Lighting source
              <select
                value={
                  received
                    ? `${received.peer}|${received.message.target || "default"}`
                    : ""
                }
                onChange={(e) => setSelectedTarget(e.target.value)}
              >
                {states.map((s) => (
                  <option
                    key={`${s.peer}|${s.message.target || "default"}`}
                    value={`${s.peer}|${s.message.target || "default"}`}
                  >
                    {s.message.target || "Default target"} · {s.peer}
                  </option>
                ))}
              </select>
            </label>
          )}
          {look ? (
            <>
              <div className="lighting-cue">
                <div>
                  <span className="eyebrow">
                    {look.page?.name || "Current lighting"}
                  </span>
                  <h3>{look.cue?.name || "Live stage look"}</h3>
                  <p>
                    {received.peer} ·{" "}
                    {new Date(received.receivedAt).toLocaleTimeString()} ·{" "}
                    {look.reason || "look report"}
                  </p>
                </div>
                <div className="look-badges">
                  {look.test && <span className="state-label">Test only</span>}
                  {received.stale && <span className="state-label">Stale</span>}
                  <span className="state-label">
                    {look.output?.blackout
                      ? "Blackout"
                      : look.output?.armed === false
                        ? "Preview only"
                        : look.output?.armed
                          ? "Live output"
                          : "Output unknown"}
                  </span>
                </div>
              </div>
              <div className="lighting-zones">
                {(look.zones ?? look.groups ?? []).map((z, index) => (
                  <article className="lighting-zone" key={z.id || index}>
                    <div
                      className="zone-swatch"
                      style={{ backgroundColor: z.color || "#777" }}
                    />
                    <div>
                      <span className="eyebrow">
                        {z.role || "Legacy group"}
                      </span>
                      <h4>{z.name || z.id || "Unnamed zone"}</h4>
                      <div className="zone-measures">
                        <strong>
                          {z.kelvin
                            ? `${Math.round(z.kelvin).toLocaleString()} K`
                            : "No CCT"}
                        </strong>
                        <span>
                          {z.white === true
                            ? "White light"
                            : z.white === false
                              ? "Intentional color"
                              : "Color unclassified"}
                        </span>
                      </div>
                      <meter
                        aria-label={`${z.name || z.id} light level`}
                        min={0}
                        max={1}
                        value={z.level || 0}
                      />
                      <p>
                        {Math.round((z.level || 0) * 100)}% level ·{" "}
                        {z.lit ?? "?"}/{z.fixtures ?? "?"} lit
                        {(z.colorUnknown || 0) > 0
                          ? ` · ${z.colorUnknown} uncertain colors`
                          : ""}
                      </p>
                    </div>
                  </article>
                ))}
              </div>
              {!look.zones?.length && !look.groups?.length && (
                <p className="form-note">
                  Overall report only: {look.kelvin || "Unknown"} K ·{" "}
                  {Math.round((look.level || 0) * 100)}% level. No reference
                  zones supplied.
                </p>
              )}
              <div className="lighting-analysis">
                <Lightbulb size={20} />
                <div>
                  <h4>
                    {analysis?.hold ||
                      (analysis?.nominalKelvin
                        ? `Reference light: ${analysis.nominalKelvin.toLocaleString()} K`
                        : "Lighting context available")}
                  </h4>
                  <p>
                    {analysis?.references
                      ?.map((r: any) => r.name || r.id)
                      .join(" + ") || "No suitable face/front/top reference"}
                    {analysis?.tintDirection
                      ? ` · nominal tint direction: ${analysis.tintDirection}`
                      : ""}
                  </p>
                  <p>
                    These are fixture estimates. Your assistant can combine them
                    with a fresh camera frame; it will not automatically
                    neutralize colored stage light.
                  </p>
                </div>
              </div>
              <details>
                <summary>Full received report</summary>
                <pre className="look-json">{JSON.stringify(look, null, 2)}</pre>
              </details>
            </>
          ) : (
            <div className="look-empty">
              <Radio size={36} />
              <h3>Waiting for the stage</h3>
              <p>
                Enable the connection, add Shader as a target in StageLight,
                then send a look. Or view an example to explore the zone
                display.
              </p>
              <button onClick={() => setTab("connection")}>
                <Link2 size={15} />
                Set up connection
              </button>
            </div>
          )}
          {!!state?.events?.length && (
            <details className="lighting-events">
              <summary>Recent messages & decisions</summary>
              {state.events.slice(0, 12).map((event: any, i: number) => (
                <div className="look-event" key={i}>
                  <strong>
                    {event.type} · {event.status}
                    <time>{new Date(event.at).toLocaleTimeString()}</time>
                  </strong>
                  <span>{event.summary}</span>
                </div>
              ))}
            </details>
          )}
        </section>
      )}
      {tab === "connection" && config && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await perform("lighting_configure", {
                ...config,
                allowedSenders: senders.split(/[\s,]+/).filter(Boolean),
              });
              await reload(true);
              setNotice("Lighting connection settings saved.");
            });
          }}
        >
          <div className="look-two-columns">
            <section>
              <h3>Receive from StageLight</h3>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  onChange={(e) => set("enabled", e.target.checked)}
                />
                Enable lighting receiver
              </label>
              <label>
                Listen on
                <select
                  value={config.bind}
                  onChange={(e) => set("bind", e.target.value)}
                >
                  <option value="127.0.0.1">This computer only</option>
                  <option value="0.0.0.0">Show network</option>
                </select>
              </label>
              <label>
                Allowed StageLight IPv4 addresses
                <input
                  value={senders}
                  onChange={(e) => setSenders(e.target.value)}
                  placeholder="192.168.1.20"
                />
              </label>
              <p className="form-note">
                Separate addresses with commas. Required for the show network.
                Localhost is always allowed.
              </p>
              <label>
                HTTP port
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  required
                  value={config.httpPort}
                  onChange={(e) => set("httpPort", Number(e.target.value))}
                />
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={config.oscEnabled}
                  onChange={(e) => set("oscEnabled", e.target.checked)}
                />
                Also receive OSC over UDP
              </label>
              <label>
                OSC receive port
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  required
                  value={config.oscPort}
                  onChange={(e) => set("oscPort", Number(e.target.value))}
                />
              </label>
            </section>
            <section>
              <h3>Reply to StageLight</h3>
              <label>
                StageLight computer IPv4
                <input
                  required
                  value={config.stageHost}
                  onChange={(e) => set("stageHost", e.target.value)}
                />
              </label>
              <label>
                StageLight OSC port
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  required
                  value={config.stagePort}
                  onChange={(e) => set("stagePort", Number(e.target.value))}
                />
              </label>
              <label>
                Shader's target ID in StageLight
                <input
                  maxLength={200}
                  value={config.targetId}
                  onChange={(e) => set("targetId", e.target.value)}
                />
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={config.feedback}
                  onChange={(e) => set("feedback", e.target.checked)}
                />
                Send recall results back to StageLight
              </label>
              <p className="form-note">
                Requests and feedback use StageLight's OSC port, normally 1461.
                On a second computer, allow Shader's address in StageLight's
                Show network settings.
              </p>
            </section>
          </div>
          <fieldset className="look-fieldset">
            <legend>Linked recalls</legend>
            <label className="check-label">
              <input
                type="checkbox"
                checked={config.automation}
                onChange={(e) => set("automation", e.target.checked)}
              />
              Allow lighting cues and preset messages to recall saved looks
            </label>
            <p className="form-note">
              Camera write locks still apply. Enable each linked camera before a
              show. Preview, blackout and test reports hold camera settings.
            </p>
            <label className="check-label">
              <input
                type="checkbox"
                checked={config.legacyLive}
                onChange={(e) => set("legacyLive", e.target.checked)}
              />
              Trust older senders that do not report live-output state
            </label>
            <p className="form-note">
              Leave this off for current StageLight. When enabled, a missing
              live report can no longer protect against a preview-only cue.
            </p>
          </fieldset>
          <button className="primary" disabled={busy}>
            Save connection
          </button>
          <div className="lighting-endpoint">
            <h4>HTTP target URL · saved configuration</h4>
            <input
              aria-label="StageLight HTTP target URL"
              readOnly
              value={settings?.endpoint || ""}
              onFocus={(e) => e.target.select()}
            />
            <div className="look-row">
              <p className="form-note">
                Paste into StageLight → Network & triggers → Send to. For Show
                network, replace &lt;this-computer-IP&gt; with Shader's address.
                The private path is your receiver key.
              </p>
              <button
                type="button"
                onClick={() =>
                  void act(async () => {
                    await navigator.clipboard.writeText(settings.endpoint);
                    setNotice("Receiver URL copied.");
                  })
                }
              >
                <Copy size={14} />
                Copy URL
              </button>
            </div>
          </div>
          <button
            type="button"
            className="quiet"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await perform("lighting_reset");
                setNotice(
                  "Reception history reset. Request a fresh look after restarting StageLight.",
                );
              })
            }
          >
            Reset reception after a StageLight restart
          </button>
        </form>
      )}
      {tab === "rules" && (
        <section>
          <div className="look-row">
            <div>
              <h3>When this cue plays, recall this look.</h3>
              <p className="muted">
                StageLight can also send a preset ID directly, without a mapping
                here.
              </p>
            </div>
            <button
              disabled={!state?.listening || busy}
              onClick={() =>
                void act(async () => {
                  const result = await perform("lighting_publish_presets");
                  setNotice(`${result.sent} presets published to StageLight.`);
                })
              }
            >
              Publish preset list
            </button>
          </div>
          <div className="lighting-rules">
            {settings?.rules?.map((r: LightingRule) => (
              <div className="look-rule" key={r.id}>
                <div>
                  <strong>{r.name}</strong>
                  <p>
                    {r.cueName || r.entryId || r.cueId} →{" "}
                    {presets.find((p) => p.id === r.presetId)?.name ||
                      "Preset unavailable"}
                  </p>
                  <small>
                    {r.enabled ? "Enabled" : "Disabled"} ·{" "}
                    {r.fade !== undefined
                      ? `${r.fade}s transition`
                      : "Follow cue transition"}
                  </small>
                </div>
                <button onClick={() => setRule(r)}>Edit</button>
                <button
                  className="icon"
                  aria-label={`Delete mapping ${r.name}`}
                  onClick={() =>
                    void act(async () => {
                      await perform("lighting_rule_delete", { id: r.id });
                      await reload();
                    })
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const cleaned = Object.fromEntries(
                  Object.entries(rule).filter(([, v]) => v !== ""),
                );
                await perform("lighting_rule_save", cleaned);
                await reload();
                setRule({ name: "", enabled: true, presetId: "", cueName: "" });
                setNotice("Cue mapping saved.");
              });
            }}
          >
            <div className="look-row">
              <h4>{rule.id ? "Edit mapping" : "Add a cue mapping"}</h4>
              <button
                type="button"
                disabled={!look?.cue}
                onClick={() =>
                  setRule((r) => ({
                    ...r,
                    name: look?.cue?.name || "Lighting cue",
                    target: look?.target || "",
                    pageId: look?.page?.id || "",
                    entryId: look?.cue?.entry || "",
                    cueId: look?.cue?.id || "",
                    cueName: look?.cue?.name || "",
                  }))
                }
              >
                Use received cue
              </button>
            </div>
            <div className="look-two-columns">
              <label>
                Mapping name
                <input
                  required
                  maxLength={80}
                  value={rule.name}
                  onChange={(e) =>
                    setRule((r) => ({ ...r, name: e.target.value }))
                  }
                  placeholder="Warm stage"
                />
              </label>
              <label>
                Saved camera look or scene
                <select
                  required
                  value={rule.presetId}
                  onChange={(e) =>
                    setRule((r) => ({ ...r, presetId: e.target.value }))
                  }
                >
                  <option value="">Choose a preset…</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.kind}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Exact cue name
              <input
                value={rule.cueName || ""}
                maxLength={200}
                onChange={(e) =>
                  setRule((r) => ({ ...r, cueName: e.target.value }))
                }
                placeholder="Sunrise"
              />
            </label>
            <details>
              <summary>Stable cue IDs & target filter</summary>
              <div className="look-two-columns">
                {(
                  [
                    ["entryId", "Cue entry ID"],
                    ["cueId", "Cue ID"],
                    ["pageId", "Page ID"],
                    ["target", "StageLight target ID"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      value={rule[key] || ""}
                      onChange={(e) =>
                        setRule((r) => ({ ...r, [key]: e.target.value }))
                      }
                    />
                  </label>
                ))}
              </div>
              <p className="form-note">
                Every supplied field must match. Stable IDs survive renaming;
                clear the name when matching by ID alone. OSC bursts provide
                names rather than cue IDs.
              </p>
            </details>
            <label>
              Transition override in seconds · blank follows cue
              <input
                type="number"
                min={0}
                max={60}
                step={0.5}
                value={rule.fade ?? ""}
                onChange={(e) =>
                  setRule((r) => ({
                    ...r,
                    fade:
                      e.target.value === ""
                        ? undefined
                        : Number(e.target.value),
                  }))
                }
              />
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) =>
                  setRule((r) => ({ ...r, enabled: e.target.checked }))
                }
              />
              Mapping enabled
            </label>
            <button className="primary" disabled={busy || !presets.length}>
              <Plus size={15} />
              {rule.id ? "Save mapping" : "Add mapping"}
            </button>
            {rule.id && (
              <button
                type="button"
                className="quiet"
                onClick={() =>
                  setRule({
                    name: "",
                    enabled: true,
                    presetId: "",
                    cueName: "",
                  })
                }
              >
                Cancel edit
              </button>
            )}
            {!presets.length && (
              <p className="form-note">
                Save a camera look or scene in Presets first.
              </p>
            )}
          </form>
        </section>
      )}
    </div>
  );
}
