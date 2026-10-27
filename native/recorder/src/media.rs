use crate::service::WorkerConfig;
use anyhow::{anyhow, bail, ensure, Context, Result};
use base64::Engine;
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app as app;
use serde_json::{json, Value};
use shader_recorder::{
    clock, journal,
    model::{file_stem, Take, Track},
};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub fn capabilities() -> Value {
    let required = [
        "appsrc",
        "appsink",
        "queue",
        "tee",
        "videoconvert",
        "videoscale",
        "videorate",
        "jpegenc",
        "audioconvert",
        "avenc_prores_ks",
        "splitmuxsink",
        "qtmux",
        "filesink",
    ];
    let missing: Vec<_> = required
        .into_iter()
        .filter(|n| gst::ElementFactory::find(n).is_none())
        .collect();
    json!({"available":missing.is_empty(),"version":gst::version_string().as_str(),"missing":missing,"decklink":gst::ElementFactory::find("decklinkvideosrc").is_some()&&gst::ElementFactory::find("decklinkaudiosrc").is_some(),"profiles":["prores","prores-lt"],"hardwareQualified":false})
}
fn element(factory: &str, name: &str) -> Result<gst::Element> {
    gst::ElementFactory::make(factory)
        .name(name)
        .build()
        .with_context(|| format!("Missing media element: {factory}"))
}
fn queue(name: &str, leaky: bool, buffers: u32) -> Result<gst::Element> {
    let q = element("queue", name)?;
    q.set_property("max-size-buffers", buffers);
    q.set_property("max-size-bytes", 0u32);
    q.set_property("max-size-time", 0u64);
    if leaky {
        q.set_property_from_str("leaky", "downstream");
    }
    Ok(q)
}
#[derive(Default)]
struct Stats {
    video: u64,
    audio: u64,
    last_video: u64,
    last_audio: u64,
    preview_sequence: u64,
    preview: Option<String>,
    preview_at: u64,
    video_caps: Option<gst::Caps>,
    audio_caps: Option<gst::Caps>,
    error: Option<String>,
    record_error: Option<String>,
    meters: Vec<f64>,
    video_end: Option<u64>,
    audio_end: Option<u64>,
    discontinuities: u64,
}
#[derive(Clone)]
struct Feed {
    video: app::AppSrc,
    audio: app::AppSrc,
    start: u64,
    stop: Arc<Mutex<Option<u64>>>,
    first: Arc<Mutex<Option<u64>>>,
    last: Arc<Mutex<Option<u64>>>,
    _awake: Arc<Awake>,
}
struct Recording {
    pipeline: gst::Pipeline,
    bus: gst::Bus,
    feed: Feed,
    take: Take,
    track: Track,
    parts: Vec<Value>,
    opened: HashParts,
    pending_closed: Vec<(String, u64, Instant)>,
    last_flush: Instant,
}
type HashParts = std::collections::HashMap<String, u64>;
pub struct Capture {
    pub config: WorkerConfig,
    pipeline: gst::Pipeline,
    bus: gst::Bus,
    stats: Arc<Mutex<Stats>>,
    feed: Arc<Mutex<Option<Feed>>>,
    record: Option<Recording>,
    last_take: Option<String>,
    last_stop: Option<String>,
    idle_since: Instant,
}
struct Awake {
    _stop: std::sync::mpsc::Sender<()>,
}
impl Awake {
    fn new() -> Self {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            #[cfg(windows)]
            unsafe {
                use windows_sys::Win32::System::Power::*;
                SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
            }
            let _ = rx.recv();
            #[cfg(windows)]
            unsafe {
                use windows_sys::Win32::System::Power::*;
                SetThreadExecutionState(ES_CONTINUOUS);
            }
        });
        Self { _stop: tx }
    }
}
fn appsink(name: &str) -> Result<app::AppSink> {
    let sink = element("appsink", name)?
        .downcast::<app::AppSink>()
        .map_err(|_| anyhow!("Invalid appsink"))?;
    sink.set_sync(false);
    sink.set_max_buffers(2);
    sink.set_drop(false);
    Ok(sink)
}
impl Capture {
    pub fn open(config: WorkerConfig) -> Result<Self> {
        config.source.validate()?;
        let source = &config.source;
        let pipeline = gst::Pipeline::new();
        pipeline.use_clock(Some(&gst::SystemClock::obtain()));
        let stats = Arc::new(Mutex::new(Stats::default()));
        let feed = Arc::new(Mutex::new(None::<Feed>));
        let video = element(
            if source.simulated {
                "videotestsrc"
            } else {
                "decklinkvideosrc"
            },
            "video-input",
        )?;
        let audio = element(
            if source.simulated {
                "audiotestsrc"
            } else {
                "decklinkaudiosrc"
            },
            "audio-input",
        )?;
        if source.simulated {
            video.set_property("is-live", true);
            video.set_property_from_str("pattern", "smpte");
            audio.set_property("is-live", true);
            audio.set_property("volume", 0.04f64);
        } else {
            ensure!(
                video.find_property("persistent-id").is_some(),
                "GStreamer 1.22 or later is required for stable DeckLink input identity"
            );
            video.set_property("persistent-id", source.persistent_id()?);
            audio.set_property("persistent-id", source.persistent_id()?);
            video.set_property_from_str("connection", "sdi");
            video.set_property_from_str("mode", &source.mode);
            video.set_property_from_str("video-format", "10bit-yuv");
            video.set_property("drop-no-signal-frames", true);
            // Keep the installed connector profile. Never change it as a side effect of opening Studio.
            video.set_property_from_str("profile", "default");
            audio.set_property_from_str("connection", "embedded");
            audio.set_property_from_str("channels", &source.audio_channels.to_string());
        }
        let filter = element("capsfilter", "native-format")?;
        let fraction = if source.mode == "1080p2997" {
            gst::Fraction::new(30000, 1001)
        } else {
            gst::Fraction::new(30, 1)
        };
        // Fault-injection checks exercise worker isolation on small CI runners.
        // The normal synthetic integration check remains 1080p; physical inputs
        // never take this test-only path.
        let compact_test = source.simulated
            && std::env::var("SHADER_RECORDER_TEST_INPUTS").as_deref() == Ok("1")
            && std::env::var("SHADER_RECORDER_TEST_COMPACT").as_deref() == Ok("1");
        let (width, height) = if compact_test {
            (640i32, 360i32)
        } else {
            (1920, 1080)
        };
        filter.set_property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .field("width", width)
                .field("height", height)
                .field("framerate", fraction)
                .build(),
        );
        let af = element("capsfilter", "native-audio")?;
        af.set_property(
            "caps",
            gst::Caps::builder("audio/x-raw")
                .field("format", "S32LE")
                .field("rate", 48000i32)
                .field("channels", source.audio_channels as i32)
                .field("layout", "interleaved")
                .build(),
        );
        let tee = element("tee", "raw-video")?;
        let vq = queue("video-ingest", false, 3)?;
        let aq = queue("audio-ingest", false, 8)?;
        let vs = appsink("video-samples")?;
        let asink = appsink("audio-samples")?;
        let pq = queue("preview-queue", true, 1)?;
        let rate = element("videorate", "preview-rate")?;
        rate.set_property("drop-only", true);
        let scale = element("videoscale", "preview-scale")?;
        let convert = element("videoconvert", "preview-convert")?;
        let caps = element("capsfilter", "preview-format")?;
        caps.set_property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .field("width", 480i32)
                .field("height", 270i32)
                .field("framerate", gst::Fraction::new(6, 1))
                .build(),
        );
        let jpeg = element("jpegenc", "preview-jpeg")?;
        jpeg.set_property("quality", 65i32);
        let preview = appsink("preview-samples")?;
        preview.set_drop(true);
        preview.set_max_buffers(1);
        pipeline.add_many([
            &video,
            &filter,
            &tee,
            &vq,
            vs.upcast_ref(),
            &audio,
            &af,
            &aq,
            asink.upcast_ref(),
            &pq,
            &rate,
            &scale,
            &convert,
            &caps,
            &jpeg,
            preview.upcast_ref(),
        ])?;
        gst::Element::link_many([&video, &filter, &tee])?;
        gst::Element::link_many([&tee, &vq, vs.upcast_ref()])?;
        gst::Element::link_many([&audio, &af, &aq, asink.upcast_ref()])?;
        gst::Element::link_many([
            &tee,
            &pq,
            &rate,
            &scale,
            &convert,
            &caps,
            &jpeg,
            preview.upcast_ref(),
        ])?;
        for (sink, is_video) in [(vs, true), (asink, false)] {
            let stats = stats.clone();
            let feed = feed.clone();
            let pipeline = pipeline.downgrade();
            sink.set_callbacks(app::AppSinkCallbacks::builder().new_sample(move|sink|{
                let sample=sink.pull_sample().map_err(|_|gst::FlowError::Eos)?;
                let Some(buffer)=sample.buffer()else{return Ok(gst::FlowSuccess::Ok)};
                let now=clock::ticks();let base=pipeline.upgrade().and_then(|p|p.base_time()).map(|t|t.nseconds()).unwrap_or(now);
                let absolute=base.saturating_add(buffer.pts().map(|t|t.nseconds()).unwrap_or(0));
                {
                    let mut s=stats.lock().unwrap();
                    if is_video{s.video+=1;s.last_video=now;s.video_caps=sample.caps().map(|c|c.to_owned());}
                    else{s.audio+=1;s.last_audio=now;s.audio_caps=sample.caps().map(|c|c.to_owned());
                        if let Ok(map)=buffer.map_readable(){let channels=sample.caps().and_then(|c|c.structure(0)).and_then(|s|s.get::<i32>("channels").ok()).unwrap_or(2) as usize;
                            let mut levels=vec![0f64;channels];for (i,b) in map.as_slice().chunks_exact(4).enumerate(){if !(i/channels).is_multiple_of(4){continue;}let channel=i%channels;levels[channel]=levels[channel].max((i32::from_le_bytes(b.try_into().unwrap()) as f64/i32::MAX as f64).abs());}s.meters=levels;
                        }
                    }
                }
                let current=feed.lock().unwrap().clone();
                if let Some(f)=current{
                    let stop=*f.stop.lock().unwrap();if absolute<f.start||stop.is_some_and(|end|absolute>=end){return Ok(gst::FlowSuccess::Ok);}
                    let target=if is_video{&f.video}else{&f.audio};
                    if target.current_level_buffers()>=if is_video{8}else{32}{
                        stats.lock().unwrap().record_error=Some("Recording queue overflow; input could not be saved without loss".into());
                        return Ok(gst::FlowSuccess::Ok);
                    }
                    let mut copy=buffer.copy();
                    {let b=copy.get_mut().unwrap();b.set_pts(gst::ClockTime::from_nseconds(absolute-f.start));b.set_dts(gst::ClockTime::NONE);}
                    if is_video{
                        let mut first=f.first.lock().unwrap();if first.is_none(){*first=Some(absolute-f.start);}drop(first);
                        *f.last.lock().unwrap()=Some(absolute-f.start+buffer.duration().map(|d|d.nseconds()).unwrap_or(33_333_333));
                    }
                    if let Err(e)=target.push_buffer(copy){stats.lock().unwrap().record_error=Some(format!("Recording pipeline stopped accepting media: {e}"));}
                }
                Ok(gst::FlowSuccess::Ok)
            }).build());
        }
        {
            let s = stats.clone();
            preview.set_callbacks(
                app::AppSinkCallbacks::builder()
                    .new_sample(move |sink| {
                        let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                        if let Some(b) = sample.buffer() {
                            if let Ok(map) = b.map_readable() {
                                let mut s = s.lock().unwrap();
                                s.preview = Some(
                                    base64::engine::general_purpose::STANDARD
                                        .encode(map.as_slice()),
                                );
                                s.preview_sequence += 1;
                                s.preview_at = clock::ticks();
                            }
                        }
                        Ok(gst::FlowSuccess::Ok)
                    })
                    .build(),
            );
        }
        let bus = pipeline
            .bus()
            .ok_or_else(|| anyhow!("Capture bus unavailable"))?;
        pipeline.set_state(gst::State::Playing)?;
        Ok(Self {
            config,
            pipeline,
            bus,
            stats,
            feed,
            record: None,
            last_take: None,
            last_stop: None,
            idle_since: Instant::now(),
        })
    }
    fn ready(&self) -> bool {
        let s = self.stats.lock().unwrap();
        s.error.is_none()
            && clock::ticks().saturating_sub(s.last_video) < 2_000_000_000
            && clock::ticks().saturating_sub(s.last_audio) < 2_000_000_000
            && s.video > 2
            && s.audio > 0
    }
    fn status(&self) -> Value {
        let ready = self.ready();
        let s = self.stats.lock().unwrap();
        json!({"sourceId":self.config.source.id,"ready":ready,"recording":self.record.is_some(),"takeId":self.last_take,"stoppedTicks":self.last_stop,"error":s.error,"recordError":s.record_error,"videoFrames":s.video.to_string(),"audioPackets":s.audio.to_string(),"format":s.video_caps.as_ref().map(|c|c.to_string()),"audio":s.audio_caps.as_ref().map(|c|c.to_string()),"meters":s.meters,"lastVideoTicks":s.last_video.to_string(),"lastAudioTicks":s.last_audio.to_string(),"simulated":self.config.source.simulated,"queueBuffers":self.record.as_ref().map(|r|r.feed.video.current_level_buffers()),"segments":self.record.as_ref().map(|r|&r.parts),"durability":"Periodic MOV checkpoints; hardware power-loss qualification pending"})
    }
    pub fn command(&mut self, name: &str, args: Value) -> Result<Value> {
        self.idle_since = Instant::now();
        match name {
            "status" => {
                self.tick();
                Ok(self.status())
            }
            "preview" => {
                let s = self.stats.lock().unwrap();
                let age = clock::ticks().saturating_sub(s.preview_at);
                let live = s.last_video > 0
                    && clock::ticks().saturating_sub(s.last_video) < 2_000_000_000
                    && s.preview_at > 0
                    && age < 2_000_000_000;
                let after = args["afterSequence"].as_u64().unwrap_or(0);
                Ok(
                    json!({"sequence":s.preview_sequence,"status":if live{"live"}else{"waiting"},"data":if live&&s.preview_sequence>after{s.preview.as_ref()}else{None},"capturedAt":(clock::utc_ms()-(age/1_000_000) as i64).to_string()}),
                )
            }
            "record" => {
                let take: Take = serde_json::from_value(args["take"].clone())?;
                let track: Track = serde_json::from_value(args["track"].clone())?;
                self.start(take, track)?;
                Ok(self.status())
            }
            "stop" => {
                if let Err(e) = self.stop(args["stopTicks"].as_str().and_then(|s| s.parse().ok())) {
                    self.stats.lock().unwrap().record_error = Some(e.to_string());
                    return Err(e);
                }
                Ok(self.status())
            }
            "shutdown" => {
                ensure!(self.record.is_none(), "Recording input cannot be released");
                self.pipeline.set_state(gst::State::Null)?;
                let _ = fs::remove_file(self.config.directory.join("worker.json"));
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_millis(150));
                    std::process::exit(0);
                });
                Ok(json!({"ok":true}))
            }
            _ => bail!("Unknown worker command"),
        }
    }
    fn start(&mut self, take: Take, track: Track) -> Result<()> {
        if let Some(r) = &self.record {
            ensure!(r.take.id == take.id, "Input is already recording");
            return Ok(());
        }
        ensure!(self.ready(), "Input video/audio are not ready");
        ensure!(
            track.source.id == self.config.source.id,
            "Track/source mismatch"
        );
        let start = take.started_ticks.parse::<u64>()?;
        ensure!(
            start > clock::ticks(),
            "Recording start boundary was missed; retry the take"
        );
        let (vc, ac) = {
            let s = self.stats.lock().unwrap();
            (s.video_caps.clone().unwrap(), s.audio_caps.clone().unwrap())
        };
        let pipeline = gst::Pipeline::new();
        pipeline.use_clock(Some(&gst::SystemClock::obtain()));
        let video = element("appsrc", "record-video")?
            .downcast::<app::AppSrc>()
            .map_err(|_| anyhow!("Appsrc missing"))?;
        let audio = element("appsrc", "record-audio")?
            .downcast::<app::AppSrc>()
            .map_err(|_| anyhow!("Appsrc missing"))?;
        for src in [&video, &audio] {
            src.set_is_live(true);
            src.set_format(gst::Format::Time);
            src.set_block(false);
            src.set_max_bytes(0);
            src.set_max_buffers(if src == &video { 8 } else { 32 });
        }
        video.set_caps(Some(&vc));
        audio.set_caps(Some(&ac));
        let convert = element("videoconvert", "record-convert")?;
        let vf = element("capsfilter", "encoder-format")?;
        vf.set_property(
            "caps",
            gst::Caps::builder("video/x-raw")
                .field("format", "I422_10LE")
                .build(),
        );
        let encoder = element("avenc_prores_ks", "record-encoder")?;
        encoder.set_property_from_str("threads", "auto");
        encoder.set_property_from_str(
            "profile",
            if take.profile == "prores-lt" {
                "lt"
            } else {
                "standard"
            },
        );
        // Native S32LE PCM is already accepted by qtmux. Preserve its channel layout.
        let mux = element("splitmuxsink", "record-files")?;
        // Request fsync/_commit on the filesink's own handle. Opening a second
        // writer for live flushing conflicts with Windows file-sharing rules.
        mux.connect("sink-added", false, |values| {
            let sink = values[1].get::<gst::Element>().expect("sink-added element");
            let pad = sink.static_pad("sink").expect("filesink sink pad");
            let last = Mutex::new(Instant::now());
            pad.add_probe(
                gst::PadProbeType::BUFFER | gst::PadProbeType::BUFFER_LIST,
                move |_, info| {
                    let mut last = last.lock().unwrap();
                    if last.elapsed() >= Duration::from_secs(2) {
                        if let Some(buffer) = info.buffer_mut() {
                            buffer.make_mut().set_flags(gst::BufferFlags::SYNC_AFTER);
                            *last = Instant::now();
                        } else if let Some(list) = info.buffer_list_mut() {
                            let list = list.make_mut();
                            if let Some(index) = list.len().checked_sub(1) {
                                if let Some(buffer) = list.get_mut(index) {
                                    buffer.set_flags(gst::BufferFlags::SYNC_AFTER);
                                    *last = Instant::now();
                                }
                            }
                        }
                    }
                    gst::PadProbeReturn::Ok
                },
            );
            None
        });
        let prefix = format!(
            "{}_SDI-{}_{}",
            file_stem(&track.source.name),
            track.source.connector.unwrap_or(0),
            &uuid::Uuid::new_v4().to_string()[..8]
        );
        let location = track.folder.join(format!("{prefix}_part-%05d.mov.partial"));
        mux.set_property(
            "location",
            location
                .to_str()
                .ok_or_else(|| anyhow!("Output path encoding unsupported"))?,
        );
        let segment_seconds = std::env::var("SHADER_RECORDER_SEGMENT_SECONDS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .filter(|n| (2..=300).contains(n))
            .unwrap_or(300);
        mux.set_property("max-size-time", segment_seconds * 1_000_000_000);
        mux.set_property("max-size-bytes", 0u64);
        mux.set_property("async-finalize", true);
        mux.set_property("muxer-factory", "qtmux");
        mux.set_property("use-robust-muxing", true);
        mux.set_property(
            "muxer-properties",
            gst::Structure::builder("properties")
                .field(
                    "reserved-max-duration",
                    (segment_seconds + 10) * 1_000_000_000,
                )
                .field("reserved-moov-update-period", 2_000_000_000u64)
                .field("reserved-bytes-per-sec", 20000u32)
                .build(),
        );
        pipeline.add_many([
            video.upcast_ref(),
            &convert,
            &vf,
            &encoder,
            audio.upcast_ref(),
            &mux,
        ])?;
        gst::Element::link_many([video.upcast_ref(), &convert, &vf, &encoder])?;
        encoder.link_pads(Some("src"), &mux, Some("video"))?;
        audio.link_pads(Some("src"), &mux, Some("audio_%u"))?;
        let bus = pipeline.bus().unwrap();
        let stop = take.duration_seconds.map(|d| start + d * 1_000_000_000);
        let feed = Feed {
            video,
            audio,
            start,
            stop: Arc::new(Mutex::new(stop)),
            first: Arc::new(Mutex::new(None)),
            last: Arc::new(Mutex::new(None)),
            _awake: Arc::new(Awake::new()),
        };
        {
            let mut s = self.stats.lock().unwrap();
            s.record_error = None;
            s.video_end = None;
            s.audio_end = None;
            s.discontinuities = 0;
        }
        let record = Recording {
            pipeline,
            bus,
            feed,
            take,
            track,
            parts: vec![],
            opened: HashParts::new(),
            pending_closed: vec![],
            last_flush: Instant::now(),
        };
        journal::atomic_json(
            &self.config.directory.join("active.json"),
            &json!({"take":record.take,"track":record.track}),
        )?;
        ensure!(
            start > clock::ticks() + 50_000_000,
            "Recording preparation missed the shared start boundary; retry the take"
        );
        record.pipeline.set_state(gst::State::Playing)?;
        self.last_take = Some(record.take.id.clone());
        self.last_stop = None;
        *self.feed.lock().unwrap() = Some(record.feed.clone());
        self.record = Some(record);
        Ok(())
    }
    pub fn tick(&mut self) {
        while let Some(message) = self.bus.pop() {
            match message.view() {
                gst::MessageView::Error(e) => {
                    self.stats.lock().unwrap().error = Some(format!("Capture: {}", e.error()))
                }
                gst::MessageView::Eos(..) => {
                    self.stats.lock().unwrap().error = Some("Capture stream ended".into())
                }
                _ => {}
            }
        }
        if let Some(r) = self.record.as_mut() {
            while let Some(m) = r.bus.pop() {
                if let Err(e) = r.message(&m) {
                    self.stats.lock().unwrap().record_error = Some(e.to_string());
                }
            }
            if let Err(e) = r.finalize_closed(false) {
                self.stats.lock().unwrap().record_error = Some(e.to_string());
            }
            if r.last_flush.elapsed() > Duration::from_secs(2) {
                let flush = (|| -> Result<()> {
                    ensure!(
                        fs2::available_space(&r.track.folder)? > 2 * 1024 * 1024 * 1024,
                        "Recording drive is nearly full; finishing files"
                    );
                    Ok(())
                })();
                if let Err(e) = flush {
                    self.stats.lock().unwrap().record_error = Some(format!("Recording drive: {e}"));
                }
                r.last_flush = Instant::now();
            }
        }
        let should_stop = self.record.as_ref().is_some_and(|r| {
            r.feed
                .stop
                .lock()
                .unwrap()
                .is_some_and(|end| clock::ticks() > end + 100_000_000)
        });
        let input_failed = self.record.is_some() && !self.ready();
        if input_failed {
            self.stats.lock().unwrap().record_error.get_or_insert(
                "Input lost video or audio; recording stopped and partial media preserved".into(),
            );
        }
        let record_failed =
            self.record.is_some() && self.stats.lock().unwrap().record_error.is_some();
        if should_stop || record_failed {
            {
                let s = self.stats.lock().unwrap();
                eprintln!(
                    "Stopping: scheduled={should_stop}, record_error={:?}, capture_error={:?}",
                    s.record_error, s.error
                );
            }
            if let Err(e) = self.stop(None) {
                self.stats.lock().unwrap().record_error = Some(e.to_string());
            }
        }
        // A worker never relies on a UI heartbeat while recording. Idle workers can exit after the service has vanished.
    }
    fn stop(&mut self, stop: Option<u64>) -> Result<()> {
        let Some(mut r) = self.record.take() else {
            return Ok(());
        };
        let boundary = stop
            .or(*r.feed.stop.lock().unwrap())
            .unwrap_or_else(clock::ticks)
            .min(clock::ticks() + 1_000_000_000);
        *r.feed.stop.lock().unwrap() = Some(boundary);
        if clock::ticks() < boundary {
            std::thread::sleep(Duration::from_nanos(
                boundary.saturating_sub(clock::ticks()),
            ));
        }
        *self.feed.lock().unwrap() = None;
        r.feed.video.end_of_stream()?;
        r.feed.audio.end_of_stream()?;
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut eos = false;
        let mut error = None;
        while Instant::now() < deadline {
            if let Some(m) = r.bus.timed_pop(gst::ClockTime::from_mseconds(100)) {
                if matches!(m.view(), gst::MessageView::Eos(..)) {
                    eos = true;
                    break;
                }
                if let Err(e) = r.message(&m) {
                    error = Some(e);
                    break;
                }
            }
        }
        r.pipeline.set_state(gst::State::Null)?;
        while let Some(m) = r.bus.pop() {
            if let Err(e) = r.message(&m) {
                error = Some(e);
            }
        }
        if let Err(e) = r.finalize_closed(true) {
            error = Some(e);
        }
        self.last_stop = Some(boundary.to_string());
        let _ = fs::remove_file(self.config.directory.join("active.json"));
        if let Some(e) = error {
            self.stats.lock().unwrap().record_error = Some(e.to_string());
            return Err(e);
        }
        if !eos {
            self.stats.lock().unwrap().record_error =
                Some("Recording finalization timed out; partial files preserved".into());
            bail!("Recording finalization timed out; partial files preserved");
        }
        if let (Some(part), Some(last)) = (r.parts.last_mut(), *r.feed.last.lock().unwrap()) {
            part["endSessionTicks"] = json!(last.to_string());
        }
        journal::atomic_json(&r.track.folder.join("segments.json"), &r.parts)?;
        journal::atomic_json(
            &r.track.folder.join("track-report.json"),
            &json!({"takeId":r.take.id,"source":r.track.source,"firstSessionTicks":r.feed.first.lock().unwrap().map(|t|t.to_string()),"lastSessionTicks":r.feed.last.lock().unwrap().map(|t|t.to_string()),"stoppedTicks":boundary.to_string(),"parts":r.parts,"error":self.stats.lock().unwrap().record_error,"sync":"software-aligned; hardware qualification pending"}),
        )?;
        Ok(())
    }
}
impl Drop for Recording {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}
impl Recording {
    fn message(&mut self, message: &gst::Message) -> Result<()> {
        match message.view() {
            gst::MessageView::Error(e) => bail!("Recording: {} ({:?})", e.error(), e.debug()),
            gst::MessageView::Element(e) => {
                let Some(s) = e.structure() else {
                    return Ok(());
                };
                let name = s.name();
                if name == "splitmuxsink-fragment-opened" || name == "splitmuxsink-fragment-closed"
                {
                    let file = s.get::<String>("location")?;
                    let running = s
                        .get::<gst::ClockTime>("running-time")
                        .map(|t| t.nseconds())
                        .unwrap_or(0);
                    if name == "splitmuxsink-fragment-opened" {
                        self.opened.insert(file, running);
                    } else {
                        let path = PathBuf::from(&file);
                        ensure!(
                            path.parent() == Some(self.track.folder.as_path()),
                            "Unexpected segment location"
                        );
                        // The notification can precede the async sink closing
                        // its handle. Publish the file only once that is done.
                        self.pending_closed.push((file, running, Instant::now()));
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn finalize_closed(&mut self, require_all: bool) -> Result<()> {
        while let Some((file, running, closed_at)) = self.pending_closed.first().cloned() {
            let path = PathBuf::from(&file);
            let final_path = path.with_extension("");
            ensure!(!final_path.exists(), "Completed segment already exists");
            let result = (|| -> std::io::Result<()> {
                fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&path)?
                    .sync_all()?;
                fs::rename(&path, &final_path)
            })();
            if let Err(error) = result {
                if cfg!(windows)
                    && matches!(error.raw_os_error(), Some(32 | 33))
                    && !require_all
                    && closed_at.elapsed() < Duration::from_secs(5)
                {
                    break;
                }
                return Err(error)
                    .context("Could not finalize recording segment; partial file preserved");
            }
            self.pending_closed.remove(0);
            let start = self.opened.remove(&file).unwrap_or(0);
            let end = running.max(start);
            self.parts.push(json!({"file":final_path.file_name().unwrap().to_string_lossy(),"startSessionTicks":start.to_string(),"endSessionTicks":end.to_string(),"bytes":fs::metadata(&final_path)?.len().to_string(),"status":"finalized-and-flushed"}));
            journal::atomic_json(&self.track.folder.join("segments.json"), &self.parts)?;
        }
        Ok(())
    }
}
impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}
