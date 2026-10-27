//! StageMics v1: original UTC scene events and full-length Dante audio anchors.
use crate::{journal, model::Take};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockSample {
    pub session_clock_id: String,
    pub ticks_per_second: String,
    pub offset_ticks: String,
    pub uncertainty_ticks: String,
    pub probed_utc: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTime {
    pub domain: String,
    pub utc: String,
    pub clock_source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clock: Option<ClockSample>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Scene {
    pub id: String,
    #[serde(default)]
    pub code: Option<String>,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Audio {
    pub recording_id: String,
    pub recording_name: String,
    pub sample: String,
    pub sample_rate: u32,
    pub edited: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub protocol: String,
    pub event_id: String,
    pub sender_id: String,
    pub sender_run_id: String,
    pub sequence: String,
    pub recording_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_run_id: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub label: String,
    pub time: EventTime,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene: Option<Scene>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<Audio>,
    #[serde(default)]
    pub already_live: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enter_event_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entered_utc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
fn decimal(s: &str) -> Result<i128> {
    ensure!(
        !s.is_empty()
            && s.len() <= 20
            && s.chars()
                .enumerate()
                .all(|(i, c)| c.is_ascii_digit() || (i == 0 && c == '-')),
        "Expected a decimal integer string"
    );
    Ok(s.parse::<i64>()? as i128)
}
fn label(s: &str, max: usize) -> Result<()> {
    ensure!(
        !s.trim().is_empty() && s.chars().count() <= max && !s.contains('\0'),
        "Invalid or oversized text"
    );
    Ok(())
}
impl Event {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.protocol == "shader.recorder/1",
            "Unsupported recorder protocol"
        );
        uuid::Uuid::parse_str(&self.event_id)?;
        uuid::Uuid::parse_str(&self.sender_run_id)?;
        uuid::Uuid::parse_str(&self.recording_session_id)?;
        label(&self.sender_id, 120)?;
        label(&self.label, 200)?;
        ensure!(
            decimal(&self.sequence)? >= 0,
            "Sequence must be nonnegative"
        );
        ensure!(
            ["scene.enter", "scene.exit", "marker"].contains(&self.kind.as_str()),
            "Supported events are scene.enter, scene.exit and marker"
        );
        ensure!(
            self.scope == "all-recorded-inputs",
            "Unsupported event scope"
        );
        ensure!(
            self.time.domain == "utc",
            "StageMics v1 requires original UTC time"
        );
        ensure!(
            decimal(&self.time.utc)? >= 0,
            "UTC must be milliseconds since epoch"
        );
        label(&self.time.clock_source, 120)?;
        if let Some(c) = &self.time.clock {
            label(&c.session_clock_id, 120)?;
            ensure!(
                decimal(&c.ticks_per_second)? == 1_000_000_000,
                "Clock frequency mismatch"
            );
            decimal(&c.offset_ticks)?;
            ensure!(
                decimal(&c.uncertainty_ticks)? >= 0,
                "Negative clock uncertainty"
            );
            ensure!(decimal(&c.probed_utc)? >= 0, "Invalid clock probe time");
        }
        if self.kind.starts_with("scene.") {
            let scene = self
                .scene
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("Scene ID and name required"))?;
            label(&scene.id, 200)?;
            label(&scene.name, 200)?;
        }
        if let Some(a) = &self.audio {
            label(&a.recording_id, 200)?;
            label(&a.recording_name, 200)?;
            ensure!(decimal(&a.sample)? >= 0, "Negative audio sample");
            ensure!(
                (8_000..=384_000).contains(&a.sample_rate),
                "Invalid audio sample rate"
            );
            ensure!(
                !a.edited,
                "StageMics audio anchors must use the original full-length timeline"
            );
        }
        ensure!(
            serde_json::to_vec(self)?.len() <= 16 * 1024,
            "Event exceeds 16 KiB"
        );
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredEvent {
    pub event: Event,
    pub content_hash: String,
    pub received_utc: String,
    pub received_ticks: String,
    pub journal_sequence: String,
    pub timing: Value,
}
pub fn resolve(event: &Event, take: &Take, _current_clock: &str) -> Value {
    let start = take.started_ticks.parse::<i128>().unwrap_or(0);
    let utc = event.time.utc.parse::<i128>().unwrap_or(0);
    let Some(c) = event.time.clock.as_ref() else {
        return json!({"state":"unresolved","reason":"No clock probe supplied","originalUtc":event.time.utc});
    };
    if c.session_clock_id != take.session_clock_id {
        return json!({"state":"unresolved","reason":"Clock domain is unknown","originalUtc":event.time.utc});
    }
    let absolute = utc * 1_000_000 + c.offset_ticks.parse::<i128>().unwrap_or(0);
    let relative = absolute - start;
    let already_live = relative < 0 && event.kind == "scene.enter" && event.already_live;
    let end = take
        .stopped_ticks
        .as_ref()
        .and_then(|v| v.parse::<i128>().ok())
        .map(|t| t - start);
    let outside = relative < 0 && !already_live || end.is_some_and(|t| relative > t);
    let age = utc - c.probed_utc.parse::<i128>().unwrap_or(utc);
    json!({
        "state":if outside{"outside-take"}else{"resolved"},
        "sessionTicks":relative.to_string(),
        "visibleTicks":if already_live{"0".into()}else{relative.to_string()},
        "ticksPerSecond":"1000000000",
        "originalUtc":event.time.utc,
        "sessionClockId":c.session_clock_id,
        "uncertaintyTicks":c.uncertainty_ticks,
        "probeAgeMs":age.to_string(),
        "clockWarning":if age.abs()>90_000 {Some("Clock probe is older than 90 seconds")}else{None},
        "clampedToTakeStart":already_live,
        "provenance":"sender-clock-probe"
    })
}
pub struct MarkerStore {
    pub events: Vec<StoredEvent>,
    ids: HashMap<String, usize>,
}
impl MarkerStore {
    pub fn load(path: &Path) -> Result<Self> {
        let events = journal::read(path)?
            .into_iter()
            .map(serde_json::from_value)
            .collect::<std::result::Result<Vec<StoredEvent>, _>>()?;
        let ids = events
            .iter()
            .enumerate()
            .map(|(i, e)| (e.event.event_id.clone(), i))
            .collect();
        Ok(Self { events, ids })
    }
    pub fn add(
        &mut self,
        path: &Path,
        event: Event,
        take: &Take,
        current_clock: &str,
    ) -> Result<(bool, StoredEvent)> {
        event.validate()?;
        ensure!(
            event.recording_session_id == take.id,
            "Session ID does not match the URL"
        );
        let content_hash = journal::hash(&serde_json::to_vec(&event)?);
        if let Some(i) = self.ids.get(&event.event_id) {
            let original = &self.events[*i];
            ensure!(original.content_hash == content_hash, "EVENT_ID_CONFLICT");
            return Ok((false, original.clone()));
        }
        let stored = StoredEvent {
            timing: resolve(&event, take, current_clock),
            event,
            content_hash,
            received_utc: crate::clock::utc_ms().to_string(),
            received_ticks: crate::clock::ticks().to_string(),
            journal_sequence: (self.events.len() + 1).to_string(),
        };
        journal::append(path, &serde_json::to_value(&stored)?)?;
        self.ids
            .insert(stored.event.event_id.clone(), self.events.len());
        self.events.push(stored.clone());
        Ok((true, stored))
    }
    pub fn get(&self, id: &str) -> Option<&StoredEvent> {
        self.ids.get(id).map(|i| &self.events[*i])
    }
}
pub fn intervals(events: &[StoredEvent], take: &Take) -> Vec<Value> {
    let mut sorted: Vec<_> = events
        .iter()
        .filter(|e| e.timing["state"] == "resolved")
        .collect();
    sorted.sort_by_key(|e| {
        (
            e.timing["visibleTicks"]
                .as_str()
                .unwrap_or("0")
                .parse::<i128>()
                .unwrap_or(0),
            e.event.sequence.parse::<u64>().unwrap_or(0),
        )
    });
    let mut ranges: Vec<Value> = vec![];
    for e in sorted {
        let Some(scene) = &e.event.scene else {
            continue;
        };
        if e.event.kind == "scene.enter" {
            ranges.push(json!({"id":e.event.event_id,"scene":scene,"label":e.event.label,"startTicks":e.timing["visibleTicks"],"endTicks":null,"originalUtc":e.event.time.utc,"alreadyLive":e.event.already_live,"senderId":e.event.sender_id,"audio":e.event.audio}));
        } else if e.event.kind == "scene.exit" {
            let exact = e.event.enter_event_id.as_ref().and_then(|id| {
                ranges.iter().rposition(|r| {
                    r["id"] == *id && r["senderId"] == e.event.sender_id && r["endTicks"].is_null()
                })
            });
            let index = exact.or_else(|| {
                ranges.iter().rposition(|r| {
                    r["scene"]["id"] == scene.id
                        && r["senderId"] == e.event.sender_id
                        && r["endTicks"].is_null()
                })
            });
            if let Some(i) = index {
                ranges[i]["endTicks"] = e.timing["visibleTicks"].clone();
                ranges[i]["exitEventId"] = json!(e.event.event_id);
            }
        }
    }
    // Open scenes remain explicitly open; the visible end is the take boundary, not an inferred scene.exit.
    if let Some(stop) = &take.stopped_ticks {
        let duration =
            stop.parse::<i128>().unwrap_or(0) - take.started_ticks.parse::<i128>().unwrap_or(0);
        for r in &mut ranges {
            if r["endTicks"].is_null() {
                r["visibleEndTicks"] = json!(duration.max(0).to_string());
                r["openAtTakeEnd"] = json!(true);
            }
        }
    }
    ranges
}
pub fn export(take: &Take, events: &[StoredEvent]) -> Result<()> {
    let mut jsonl = String::new();
    let mut csv=String::from("event_id,type,label,scene_id,utc_ms,session_ticks,uncertainty_ticks,audio_recording_id,audio_sample,audio_sample_rate\r\n");
    for e in events {
        jsonl.push_str(&serde_json::to_string(e)?);
        jsonl.push('\n');
        let cells = vec![
            e.event.event_id.clone(),
            e.event.kind.clone(),
            e.event.label.clone(),
            e.event
                .scene
                .as_ref()
                .map(|s| s.id.clone())
                .unwrap_or_default(),
            e.event.time.utc.clone(),
            e.timing["sessionTicks"].as_str().unwrap_or("").into(),
            e.timing["uncertaintyTicks"].as_str().unwrap_or("").into(),
            e.event
                .audio
                .as_ref()
                .map(|a| a.recording_id.clone())
                .unwrap_or_default(),
            e.event
                .audio
                .as_ref()
                .map(|a| a.sample.clone())
                .unwrap_or_default(),
            e.event
                .audio
                .as_ref()
                .map(|a| a.sample_rate.to_string())
                .unwrap_or_default(),
        ];
        csv.push_str(
            &cells
                .iter()
                .map(|s| format!("\"{}\"", s.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(","),
        );
        csv.push_str("\r\n");
    }
    write_export(&take.directory.join("markers.jsonl"), jsonl.as_bytes())?;
    write_export(&take.directory.join("markers.csv"), csv.as_bytes())?;
    let ranges = intervals(events, take);
    journal::atomic_json(
        &take.directory.join("scenes.json"),
        &json!({"protocol":"shader.recorder-scenes/1","recordingSessionId":take.id,"ticksPerSecond":"1000000000","intervals":ranges,"automaticCuts":false}),
    )?;
    for track in &take.tracks {
        let parts = std::fs::read(track.folder.join("segments.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .unwrap_or(json!([]));
        let projected:Vec<_>=events.iter().map(|e|{
            let t=e.timing["visibleTicks"].as_str().and_then(|s|s.parse::<i128>().ok());
            let matches:Vec<_>=parts.as_array().into_iter().flatten().filter_map(|p|{
                let start=p["startSessionTicks"].as_str()?.parse::<i128>().ok()?;
                let end=p["endSessionTicks"].as_str()?.parse::<i128>().ok()?;
                let t=t?;
                (start<=t&&t<end).then(||json!({"file":p["file"],"localTicks":(t-start).to_string(),"ticksPerSecond":"1000000000"}))
            }).collect();
            json!({"event":e,"media":matches,"mediaState":if t.is_none(){"unresolved"}else if matches.is_empty(){"no-confirmed-media-at-marker"}else{"mapped"}})
        }).collect();
        journal::atomic_json(
            &track.folder.join("markers.json"),
            &json!({"protocol":"shader.recorder-markers/1","sourceId":track.source.id,"recordingName":track.source.name,"cameraIds":track.camera_ids,"events":projected,"scenes":ranges}),
        )?;
    }
    Ok(())
}
fn write_export(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    // These are derived exports. The durable journal is authoritative if a write is interrupted.
    let mut f = journal::private_file(path, false)?;
    f.set_len(0)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn take(dir: &Path) -> Take {
        Take {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Test".into(),
            directory: dir.into(),
            started_utc: "100000".into(),
            started_ticks: "10000000000".into(),
            session_clock_id: "clock-1".into(),
            ticks_per_second: "1000000000".into(),
            status: "recording".into(),
            profile: "prores".into(),
            duration_seconds: None,
            tracks: vec![],
            stopped_ticks: None,
            show_run_id: None,
            errors: vec![],
            request_hash: String::new(),
        }
    }
    fn event(t: &Take) -> Event {
        serde_json::from_value(json!({"protocol":"shader.recorder/1","eventId":uuid::Uuid::new_v4(),"senderId":"stagemics-abcd1234","senderRunId":uuid::Uuid::new_v4(),"sequence":"1","recordingSessionId":t.id,"type":"scene.enter","label":"Choir","scene":{"id":"choir","name":"Choir"},"time":{"domain":"utc","utc":"101000","clockSource":"stagemics-host","clock":{"sessionClockId":"clock-1","ticksPerSecond":"1000000000","offsetTicks":"-90000000000","uncertaintyTicks":"600000","probedUtc":"100000"}},"scope":"all-recorded-inputs"})).unwrap()
    }
    #[test]
    fn durable_replay_and_conflict() {
        let d = tempfile::tempdir().unwrap();
        let t = take(d.path());
        let p = d.path().join("journal");
        let e = event(&t);
        let mut store = MarkerStore::load(&p).unwrap();
        assert!(store.add(&p, e.clone(), &t, "clock-1").unwrap().0);
        let mut store = MarkerStore::load(&p).unwrap();
        assert!(!store.add(&p, e.clone(), &t, "clock-1").unwrap().0);
        let mut conflict = e;
        conflict.label = "Changed".into();
        assert!(store
            .add(&p, conflict, &t, "clock-1")
            .unwrap_err()
            .to_string()
            .contains("EVENT_ID_CONFLICT"));
        assert_eq!(store.events.len(), 1);
    }
    #[test]
    fn already_live_clamps_without_rewriting_original_time() {
        let d = tempfile::tempdir().unwrap();
        let t = take(d.path());
        let mut e = event(&t);
        e.time.utc = "99000".into();
        e.already_live = true;
        let timing = resolve(&e, &t, "clock-1");
        assert_eq!(timing["sessionTicks"], "-1000000000");
        assert_eq!(timing["visibleTicks"], "0");
        assert_eq!(e.time.utc, "99000");
    }
    #[test]
    fn explicit_exit_and_reentry_preserve_multiple_scene_takes() {
        let d = tempfile::tempdir().unwrap();
        let t = take(d.path());
        let p = d.path().join("journal");
        let mut store = MarkerStore::load(&p).unwrap();
        let e = event(&t);
        store.add(&p, e.clone(), &t, "clock-1").unwrap();
        let mut exit = e.clone();
        exit.event_id = uuid::Uuid::new_v4().to_string();
        exit.kind = "scene.exit".into();
        exit.sequence = "2".into();
        exit.time.utc = "102000".into();
        exit.enter_event_id = Some(e.event_id);
        store.add(&p, exit, &t, "clock-1").unwrap();
        let mut again = event(&t);
        again.sequence = "3".into();
        again.time.utc = "102000".into();
        store.add(&p, again, &t, "clock-1").unwrap();
        let r = intervals(&store.events, &t);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0]["endTicks"], "2000000000");
        assert!(r[1]["endTicks"].is_null());
    }
    #[test]
    fn missing_clock_stays_unresolved_and_edited_audio_rejected() {
        let d = tempfile::tempdir().unwrap();
        let t = take(d.path());
        let mut e = event(&t);
        e.time.clock = None;
        assert_eq!(resolve(&e, &t, "clock-1")["state"], "unresolved");
        e.audio = Some(Audio {
            recording_id: "audio".into(),
            recording_name: "Full take".into(),
            sample: "48000".into(),
            sample_rate: 48000,
            edited: true,
        });
        assert!(e.validate().is_err());
    }
}
