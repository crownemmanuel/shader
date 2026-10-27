use anyhow::{anyhow, ensure, Context, Result};
use axum::{
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Path as UrlPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use shader_recorder::{
    clock, journal,
    markers::{self, Event, MarkerStore},
    model::{file_stem, Source, Take, Track},
};
use std::{
    collections::HashMap,
    fs,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{net::TcpListener, sync::Mutex as AsyncMutex};
use uuid::Uuid;

pub fn key() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub url: String,
    pub token: String,
    pub pid: u32,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerConfig {
    pub source: Source,
    pub directory: PathBuf,
    pub token: String,
}
#[derive(Clone)]
struct Worker {
    config: WorkerConfig,
    descriptor: Descriptor,
    status: Value,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkConfig {
    enabled: bool,
    host: String,
    port: u16,
    allowed_senders: Vec<String>,
    pairing_key: String,
}
impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            host: "127.0.0.1".into(),
            port: 9202,
            allowed_senders: vec![],
            pairing_key: key(),
        }
    }
}
pub struct Service {
    directory: PathBuf,
    clock_id: String,
    token: String,
    network: NetworkConfig,
    workers: HashMap<String, Worker>,
    takes: HashMap<String, Take>,
    markers: HashMap<String, MarkerStore>,
    active: Option<String>,
    export_errors: HashMap<String, String>,
    runtime: Value,
}
#[derive(Clone)]
pub struct App {
    pub service: Arc<Mutex<Service>>,
    op: Arc<AsyncMutex<()>>,
    public_task: Arc<AsyncMutex<Option<tokio::task::JoinHandle<()>>>>,
    client: reqwest::Client,
}
type ApiResult = std::result::Result<Json<Value>, ApiError>;
pub struct ApiError(pub StatusCode, pub String, pub String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            Json(json!({"status":"rejected","code":self.1,"error":self.2})),
        )
            .into_response()
    }
}
fn error(status: StatusCode, code: &str, message: impl ToString) -> ApiError {
    ApiError(status, code.into(), message.to_string())
}
fn eq_key(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0, |v, (a, b)| v | (a ^ b)) == 0
}
fn auth(headers: &HeaderMap, token: &str) -> bool {
    headers.get("origin").is_none()
        && headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .is_some_and(|s| eq_key(s, &format!("Bearer {token}")))
}
fn take_path(root: &Path, id: &str) -> PathBuf {
    root.join("sessions").join(id)
}
fn marker_path(root: &Path, id: &str) -> PathBuf {
    take_path(root, id).join("events.journal")
}
fn persist(root: &Path, take: &Take) -> Result<()> {
    let local = take_path(root, &take.id);
    fs::create_dir_all(&local)?;
    journal::atomic_json(&local.join("take.json"), take)?;
    // Local recovery state remains authoritative if the recording volume is disconnected.
    if let Err(e) = journal::atomic_json(&take.directory.join("session.json"), take) {
        eprintln!("Recording volume metadata unavailable for {}: {e}", take.id);
    }
    Ok(())
}
impl Service {
    fn session(&self) -> Value {
        let take = self
            .active
            .as_ref()
            .and_then(|id| self.takes.get(id))
            .filter(|t| t.recording());
        json!({"protocol":"shader.recorder/1","app":"Shader","version":env!("CARGO_PKG_VERSION"),"recording":take.is_some(),"recordingSessionId":take.map(|t|&t.id),"sessionName":take.map(|t|&t.name),"showRunId":take.and_then(|t|t.show_run_id.as_ref()),"startedUtc":take.map(|t|&t.started_utc),"sessionClockId":self.clock_id,"ticksPerSecond":"1000000000"})
    }
    fn status(&self) -> Value {
        let active = self.active.as_ref().and_then(|id| self.takes.get(id));
        let mut history: Vec<_> = self.takes.values().collect();
        history.sort_by(|a, b| b.started_utc.cmp(&a.started_utc));
        history.truncate(20);
        json!({"available":true,"runtime":self.runtime,"active":active,"session":self.session(),"inputs":self.workers.values().map(|w|json!({"source":w.config.source,"state":w.status})).collect::<Vec<_>>(),"markers":self.active.as_ref().and_then(|id|self.markers.get(id)).map(|m|m.events.iter().rev().take(50).collect::<Vec<_>>()).unwrap_or_default(),"history":history,"network":{"enabled":self.network.enabled,"host":self.network.host,"port":self.network.port,"allowedSenders":self.network.allowed_senders,"protocol":"HTTP JSON","path":"/recorder/v1/session"},"exportErrors":self.export_errors,"qualification":"Hardware qualification required"})
    }
}
pub async fn run(directory: PathBuf) -> Result<()> {
    fs::create_dir_all(directory.join("workers"))?;
    fs::create_dir_all(directory.join("sessions"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    }
    let singleton = journal::private_file(&directory.join("service.lock"), false)?;
    singleton
        .try_lock_exclusive()
        .context("Recorder service is already running")?;
    let config_path = directory.join("network.json");
    let network: NetworkConfig = if config_path.exists() {
        serde_json::from_slice(&fs::read(&config_path)?)?
    } else {
        let c = NetworkConfig::default();
        journal::atomic_json(&config_path, &c)?;
        c
    };
    let runtime = crate::worker::capabilities();
    let service = Service {
        directory: directory.clone(),
        clock_id: format!("host-mono-{}", Uuid::new_v4()),
        token: key(),
        network,
        workers: HashMap::new(),
        takes: HashMap::new(),
        markers: HashMap::new(),
        active: None,
        export_errors: HashMap::new(),
        runtime,
    };
    let app = App {
        service: Arc::new(Mutex::new(service)),
        op: Arc::new(AsyncMutex::new(())),
        public_task: Arc::new(AsyncMutex::new(None)),
        client: reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(30))
            .build()?,
    };
    // Reattach live workers; their capture/recording lifetime is independent of this service.
    for entry in fs::read_dir(directory.join("workers"))? {
        let config = entry?.path().join("config.json");
        if let Ok(bytes) = fs::read(&config) {
            if let Ok(c) = serde_json::from_slice::<WorkerConfig>(&bytes) {
                if let Ok(w) = attach(&app, c).await {
                    app.service
                        .lock()
                        .unwrap()
                        .workers
                        .insert(w.config.source.id.clone(), w);
                }
            }
        }
    }
    for entry in fs::read_dir(directory.join("sessions"))? {
        let path = entry?.path().join("take.json");
        if !path.exists() {
            continue;
        }
        let mut take: Take = serde_json::from_slice(&fs::read(&path)?)?;
        let store = MarkerStore::load(&marker_path(&directory, &take.id))?;
        if take.active() {
            let service = app.service.lock().unwrap();
            let live = take.tracks.iter().any(|t| {
                service
                    .workers
                    .get(&t.source.id)
                    .is_some_and(|w| w.status["takeId"] == take.id && w.status["recording"] == true)
            });
            drop(service);
            if live {
                app.service.lock().unwrap().active = Some(take.id.clone());
                app.service.lock().unwrap().clock_id = take.session_clock_id.clone();
                take.status = "degraded".into();
                take.errors.push(
                    "Recorder service reconnected; check per-input results and clock uncertainty."
                        .into(),
                );
            } else {
                take.status = "interrupted".into();
                take.errors.push("Recorder restarted without live recording workers. Partial files were preserved.".into());
            }
            let _ = persist(&directory, &take);
        }
        let mut s = app.service.lock().unwrap();
        s.markers.insert(take.id.clone(), store);
        s.takes.insert(take.id.clone(), take);
    }
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let descriptor = Descriptor {
        url: format!("http://{}", listener.local_addr()?),
        token: app.service.lock().unwrap().token.clone(),
        pid: std::process::id(),
    };
    journal::atomic_json(&directory.join("service.json"), &descriptor)?;
    restart_public(&app).await?;
    let watch = app.clone();
    tokio::spawn(async move { watchdog(watch).await });
    let router = Router::new()
        .route("/rpc", post(rpc))
        .route("/health", get(health))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .with_state(app);
    axum::serve(listener, router).await?;
    Ok(())
}
async fn health(State(app): State<App>, headers: HeaderMap) -> ApiResult {
    let s = app.service.lock().unwrap();
    if !auth(&headers, &s.token) {
        return Err(error(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Unauthorized",
        ));
    }
    Ok(Json(json!({"ok":true,"pid":std::process::id()})))
}
async fn rpc(State(app): State<App>, headers: HeaderMap, Json(body): Json<Value>) -> ApiResult {
    {
        let s = app.service.lock().unwrap();
        if !auth(&headers, &s.token) {
            return Err(error(
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "Unauthorized",
            ));
        }
    }
    let name = body["name"].as_str().unwrap_or("");
    let args = body.get("args").cloned().unwrap_or(json!({}));
    match command(&app, name, args).await {
        Ok(v) => Ok(Json(v)),
        Err(e) => Err(error(StatusCode::BAD_REQUEST, "COMMAND_FAILED", e)),
    }
}
async fn command(app: &App, name: &str, args: Value) -> Result<Value> {
    match name {
        "status" => Ok(app.service.lock().unwrap().status()),
        "storage" => storage(args["path"].as_str().unwrap_or("")),
        "pairing_key" => Ok(json!({"pairingKey":app.service.lock().unwrap().network.pairing_key})),
        "network_configure" => {
            let _op = app.op.lock().await;
            let mut config = app.service.lock().unwrap().network.clone();
            config.enabled = args["enabled"].as_bool().unwrap_or(false);
            config.host = args["host"].as_str().unwrap_or("127.0.0.1").into();
            ensure!(
                ["127.0.0.1", "0.0.0.0"].contains(&config.host.as_str()),
                "Choose this computer or show network"
            );
            config.port = args["port"]
                .as_u64()
                .filter(|p| (1024..=65535).contains(p))
                .unwrap_or(9202) as u16;
            config.allowed_senders =
                serde_json::from_value(args.get("allowedSenders").cloned().unwrap_or(json!([])))?;
            ensure!(
                config.allowed_senders.len() <= 32
                    && config
                        .allowed_senders
                        .iter()
                        .all(|s| s.parse::<std::net::Ipv4Addr>().is_ok()),
                "Use numeric IPv4 sender addresses"
            );
            ensure!(
                config.host == "127.0.0.1" || !config.allowed_senders.is_empty(),
                "Add the StageMics computer IP before enabling the show network"
            );
            let old = {
                let mut s = app.service.lock().unwrap();
                let old = s.network.clone();
                s.network = config;
                old
            };
            if let Err(e) = restart_public(app).await {
                app.service.lock().unwrap().network = old;
                let _ = restart_public(app).await;
                return Err(e);
            }
            let s = app.service.lock().unwrap();
            journal::atomic_json(&s.directory.join("network.json"), &s.network)?;
            Ok(s.status()["network"].clone())
        }
        "monitor" => {
            let _op = app.op.lock().await;
            let sources: Vec<Source> = serde_json::from_value(args["sources"].clone())?;
            ensure!(sources.len() <= 8, "Select up to eight physical inputs");
            {
                let s = app.service.lock().unwrap();
                let union: std::collections::HashSet<_> = s
                    .workers
                    .keys()
                    .cloned()
                    .chain(sources.iter().map(|s| s.id.clone()))
                    .collect();
                ensure!(union.len()<=8,"Stop monitoring unused inputs first; the recorder supports eight simultaneous inputs");
                ensure!(
                    s.active.is_none(),
                    "Stop recording before changing monitored inputs"
                );
            }
            for source in sources {
                source.validate()?;
                ensure!(
                    !source.simulated
                        || std::env::var("SHADER_RECORDER_TEST_INPUTS").as_deref() == Ok("1"),
                    "Test sources are disabled"
                );
                let existing = app.service.lock().unwrap().workers.get(&source.id).cloned();
                let existing = existing.filter(|w| process_alive(w.descriptor.pid));
                if existing.is_none() {
                    app.service.lock().unwrap().workers.remove(&source.id);
                }
                if let Some(w) = existing {
                    ensure!(
                        w.config.source.device == source.device
                            && w.config.source.mode == source.mode
                            && w.config.source.audio_channels == source.audio_channels,
                        "Stop monitoring this input before changing its format or audio channels"
                    );
                    app.service
                        .lock()
                        .unwrap()
                        .workers
                        .get_mut(&source.id)
                        .unwrap()
                        .config
                        .source
                        .name = source.name.clone();
                    {
                        let s = app.service.lock().unwrap();
                        let config = &s.workers[&source.id].config;
                        journal::atomic_json(&config.directory.join("config.json"), config)?;
                    }
                    continue;
                }
                let root = app.service.lock().unwrap().directory.clone();
                let directory = root
                    .join("workers")
                    .join(&journal::hash(source.id.as_bytes())[..24]);
                fs::create_dir_all(&directory)?;
                let config = WorkerConfig {
                    source,
                    directory: directory.clone(),
                    token: key(),
                };
                journal::atomic_json(&directory.join("config.json"), &config)?;
                let mut cmd = Command::new(std::env::current_exe()?);
                cmd.arg("--worker")
                    .arg("--config")
                    .arg(directory.join("config.json"))
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::from(journal::private_file(
                        &directory.join("worker.log"),
                        false,
                    )?));
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x08000000);
                }
                let mut child = cmd.spawn()?;
                let mut found = None;
                for _ in 0..100 {
                    if let Some(exit) = child.try_wait()? {
                        return Err(anyhow!("Capture worker exited ({exit}). Check media runtime and input availability."));
                    }
                    if let Ok(w) = attach(app, config.clone()).await {
                        found = Some(w);
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                let Some(worker) = found else {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(anyhow!("Capture worker did not become ready"));
                };
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                app.service
                    .lock()
                    .unwrap()
                    .workers
                    .insert(config.source.id.clone(), worker);
            }
            Ok(app.service.lock().unwrap().status())
        }
        "release" => {
            let _op = app.op.lock().await;
            let ids: Vec<String> = serde_json::from_value(args["sourceIds"].clone())?;
            for id in ids {
                let w = app.service.lock().unwrap().workers.get(&id).cloned();
                if let Some(w) = w {
                    if w.status["recording"] != true {
                        if process_alive(w.descriptor.pid) {
                            worker_call(app, &w, "shutdown", json!({})).await?;
                        }
                        app.service.lock().unwrap().workers.remove(&id);
                    }
                }
            }
            Ok(json!({"ok":true}))
        }
        "preview" => {
            let source = args["sourceId"]
                .as_str()
                .ok_or_else(|| anyhow!("Source ID required"))?;
            let w = app
                .service
                .lock()
                .unwrap()
                .workers
                .get(source)
                .cloned()
                .ok_or_else(|| anyhow!("Input is not monitored"))?;
            worker_call(app, &w, "preview", args).await
        }
        "start" => start_take(app, args).await,
        "stop" => stop_take(app).await,
        "markers" => {
            let s = app.service.lock().unwrap();
            let id = args["sessionId"]
                .as_str()
                .or(s.active.as_deref())
                .ok_or_else(|| anyhow!("Choose a recording session"))?;
            let take = s.takes.get(id).ok_or_else(|| anyhow!("Unknown session"))?;
            let events = &s
                .markers
                .get(id)
                .ok_or_else(|| anyhow!("Unknown marker store"))?
                .events;
            Ok(json!({"events":events,"scenes":markers::intervals(events,take)}))
        }
        "recover" => {
            let _op = app.op.lock().await;
            let take = {
                let s = app.service.lock().unwrap();
                ensure!(s.active.is_none(), "Stop recording before recovering files");
                let id = args["sessionId"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Session ID required"))?;
                s.takes
                    .get(id)
                    .cloned()
                    .ok_or_else(|| anyhow!("Unknown recording session"))?
            };
            tokio::task::spawn_blocking(move || crate::recovery::recover(&take)).await?
        }
        "export" => {
            let mut s = app.service.lock().unwrap();
            let id = args["sessionId"]
                .as_str()
                .ok_or_else(|| anyhow!("Session ID required"))?;
            let take = s.takes.get(id).ok_or_else(|| anyhow!("Unknown session"))?;
            let events = &s.markers.get(id).unwrap().events;
            markers::export(take, events)?;
            s.export_errors.remove(id);
            Ok(json!({"ok":true}))
        }
        "marker" => {
            let mut s = app.service.lock().unwrap();
            let id = s
                .active
                .clone()
                .ok_or_else(|| anyhow!("No active recording"))?;
            let take = s.takes.get(&id).unwrap().clone();
            ensure!(take.recording(), "No active recording");
            let now = clock::utc_ms();
            let tick = clock::ticks();
            let event: Event = serde_json::from_value(
                json!({"protocol":"shader.recorder/1","eventId":Uuid::new_v4(),"senderId":"shader-operator","senderRunId":s.clock_id.trim_start_matches("host-mono-"),"sequence":(s.markers[&id].events.len()+1).to_string(),"recordingSessionId":id,"type":"marker","label":args["label"],"time":{"domain":"utc","utc":now.to_string(),"clockSource":"shader-host","clock":{"sessionClockId":s.clock_id,"ticksPerSecond":"1000000000","offsetTicks":(tick as i128-now as i128*1_000_000).to_string(),"uncertaintyTicks":"1000000","probedUtc":now.to_string()}},"scope":"all-recorded-inputs"}),
            )?;
            add_event(&mut s, &id, event)
                .map(|(_, v)| v)
                .map_err(|e| anyhow!(e.2))
        }
        "shutdown" => {
            let _op = app.op.lock().await;
            ensure!(
                !app.service
                    .lock()
                    .unwrap()
                    .takes
                    .values()
                    .any(|t| t.active()),
                "Stop and finalize the recording before exiting"
            );
            let workers: Vec<_> = app
                .service
                .lock()
                .unwrap()
                .workers
                .values()
                .cloned()
                .collect();
            for w in workers {
                let _ = worker_call(app, &w, "shutdown", json!({})).await;
            }
            let path = app.service.lock().unwrap().directory.join("service.json");
            let _ = fs::remove_file(path);
            tokio::spawn(async {
                tokio::time::sleep(Duration::from_millis(150)).await;
                std::process::exit(0);
            });
            Ok(json!({"ok":true}))
        }
        _ => Err(anyhow!("Unknown recorder command")),
    }
}
pub fn storage(path: &str) -> Result<Value> {
    let path = PathBuf::from(path);
    ensure!(
        path.is_absolute() && path.is_dir(),
        "Choose an existing local recording folder"
    );
    let path = fs::canonicalize(path)?;
    Ok(
        json!({"path":path,"freeBytes":fs2::available_space(&path)?.to_string(),"totalBytes":fs2::total_space(&path)?.to_string(),"reserveBytes":"2147483648"}),
    )
}
async fn attach(app: &App, config: WorkerConfig) -> Result<Worker> {
    let descriptor: Descriptor =
        serde_json::from_slice(&fs::read(config.directory.join("worker.json"))?)?;
    ensure!(
        descriptor.url.starts_with("http://127.0.0.1:") && descriptor.token == config.token,
        "Invalid worker descriptor"
    );
    let mut worker = Worker {
        config,
        descriptor,
        status: json!({}),
    };
    worker.status = worker_call(app, &worker, "status", json!({})).await?;
    ensure!(
        worker.status["sourceId"] == worker.config.source.id,
        "Worker identity mismatch"
    );
    Ok(worker)
}
async fn worker_call(app: &App, w: &Worker, name: &str, args: Value) -> Result<Value> {
    let res = app
        .client
        .post(format!("{}/rpc", w.descriptor.url))
        .bearer_auth(&w.descriptor.token)
        .json(&json!({"name":name,"args":args}))
        .send()
        .await?;
    let status = res.status();
    let v: Value = res.json().await?;
    ensure!(
        status.is_success(),
        "{}",
        v["error"].as_str().unwrap_or("Recorder worker failed")
    );
    Ok(v)
}
async fn restart_public(app: &App) -> Result<()> {
    let mut guard = app.public_task.lock().await;
    if let Some(task) = guard.take() {
        task.abort();
        let _ = task.await;
    }
    let config = app.service.lock().unwrap().network.clone();
    if !config.enabled {
        return Ok(());
    }
    let listener = TcpListener::bind((config.host.as_str(), config.port))
        .await
        .context("Marker port is unavailable")?;
    let router = Router::new()
        .route("/recorder/v1/session", get(public_session))
        .route("/recorder/v1/clock/probe", post(probe))
        .route("/recorder/v1/sessions/{id}/events", post(event))
        .route("/recorder/v1/sessions/{id}/events/{event}", get(get_event))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .with_state(app.clone());
    *guard = Some(tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await;
    }));
    Ok(())
}
fn public_auth(
    s: &Service,
    headers: &HeaderMap,
    peer: SocketAddr,
) -> std::result::Result<(), ApiError> {
    if headers.get("origin").is_some() {
        return Err(error(
            StatusCode::FORBIDDEN,
            "ORIGIN_REJECTED",
            "Browser requests are not accepted",
        ));
    }
    if !s.network.enabled || !auth(headers, &s.network.pairing_key) {
        return Err(error(
            StatusCode::UNAUTHORIZED,
            "UNAUTHORIZED",
            "Shader refused the pairing key",
        ));
    }
    let allowed = peer.ip().is_loopback()
        || s.network
            .allowed_senders
            .iter()
            .any(|p| p.parse::<IpAddr>().ok() == Some(peer.ip()));
    if !allowed {
        return Err(error(
            StatusCode::FORBIDDEN,
            "SENDER_REJECTED",
            "Add this sender IP to Shader's allowed senders",
        ));
    }
    Ok(())
}
async fn public_session(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ApiResult {
    let s = app.service.lock().unwrap();
    public_auth(&s, &headers, peer)?;
    Ok(Json(s.session()))
}
async fn probe(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult {
    let t2 = clock::ticks();
    let utc = clock::utc_ms();
    let s = app.service.lock().unwrap();
    public_auth(&s, &headers, peer)?;
    let body: Value = serde_json::from_slice(&body)
        .map_err(|e| error(StatusCode::BAD_REQUEST, "INVALID_PROBE", e))?;
    let t1 = body["t1"]
        .as_str()
        .filter(|s| s.len() <= 20 && s.parse::<i64>().is_ok())
        .ok_or_else(|| {
            error(
                StatusCode::BAD_REQUEST,
                "INVALID_PROBE",
                "t1 must be UTC milliseconds as a decimal string",
            )
        })?;
    Ok(Json(
        json!({"t1":t1,"t2":t2.to_string(),"t3":clock::ticks().to_string(),"utc":utc.to_string(),"sessionClockId":s.clock_id,"ticksPerSecond":"1000000000"}),
    ))
}
async fn event(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    UrlPath(id): UrlPath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> std::result::Result<(StatusCode, Json<Value>), ApiError> {
    let mut s = app.service.lock().unwrap();
    public_auth(&s, &headers, peer)?;
    let event: Event = serde_json::from_slice(&body)
        .map_err(|e| error(StatusCode::BAD_REQUEST, "INVALID_EVENT", e))?;
    let (status, value) = add_event(&mut s, &id, event)?;
    Ok((status, Json(value)))
}
fn add_event(
    s: &mut Service,
    id: &str,
    event: Event,
) -> std::result::Result<(StatusCode, Value), ApiError> {
    let take = s.takes.get(id).cloned().ok_or_else(|| {
        error(
            StatusCode::NOT_FOUND,
            "UNKNOWN_SESSION",
            "Shader no longer has that take",
        )
    })?;
    event
        .validate()
        .map_err(|e| error(StatusCode::UNPROCESSABLE_ENTITY, "INVALID_EVENT", e))?;
    if event.recording_session_id != id {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "SESSION_MISMATCH",
            "Event session does not match its URL",
        ));
    }
    let path = marker_path(&s.directory, id);
    let store = s.markers.get_mut(id).ok_or_else(|| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "JOURNAL_UNAVAILABLE",
            "Marker journal unavailable; retry this event",
        )
    })?;
    let (fresh, stored) = store.add(&path, event, &take, &s.clock_id).map_err(|e| {
        if e.to_string() == "EVENT_ID_CONFLICT" {
            error(
                StatusCode::CONFLICT,
                "EVENT_ID_CONFLICT",
                "This event ID was already saved with different content",
            )
        } else {
            error(StatusCode::SERVICE_UNAVAILABLE, "PERSISTENCE_FAILED", e)
        }
    })?;
    if let Err(e) = markers::export(&take, &store.events) {
        s.export_errors.insert(id.into(), e.to_string());
    }
    Ok((
        if fresh {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        json!({"status":if fresh{"saved"}else{"duplicate"},"eventId":stored.event.event_id,"recordingSessionId":id,"journalSequence":stored.journal_sequence,"timing":stored.timing}),
    ))
}
async fn get_event(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    UrlPath((id, event)): UrlPath<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    let s = app.service.lock().unwrap();
    public_auth(&s, &headers, peer)?;
    let e = s
        .markers
        .get(&id)
        .and_then(|m| m.get(&event))
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "UNKNOWN_EVENT", "Event not found"))?;
    Ok(Json(
        json!({"status":"saved","eventId":event,"recordingSessionId":id,"event":e}),
    ))
}

// Recording operations are serialized, but each worker starts/stops concurrently.
async fn start_take(app: &App, args: Value) -> Result<Value> {
    let _op = app.op.lock().await;
    let id = args["requestId"]
        .as_str()
        .ok_or_else(|| anyhow!("Start request ID required"))?
        .to_string();
    Uuid::parse_str(&id)?;
    let request_hash = journal::hash(&serde_json::to_vec(&args)?);
    {
        let s = app.service.lock().unwrap();
        if let Some(t) = s.takes.get(&id) {
            ensure!(t.request_hash == request_hash, "Start request ID conflict");
            return Ok(json!(t));
        }
        ensure!(
            !s.takes.values().any(|t| t.active()),
            "A recording is already active"
        );
    }
    let name = args["name"].as_str().unwrap_or("").trim();
    ensure!(
        !name.is_empty() && name.chars().count() <= 80,
        "Enter a session name"
    );
    let profile = args["profile"].as_str().unwrap_or("prores");
    ensure!(
        ["prores", "prores-lt"].contains(&profile),
        "Choose a supported recording profile"
    );
    let source_ids: Vec<String> = serde_json::from_value(args["sourceIds"].clone())?;
    ensure!(
        !source_ids.is_empty() && source_ids.len() <= 8,
        "Select one to eight inputs"
    );
    let unique: std::collections::HashSet<_> = source_ids.iter().collect();
    ensure!(
        unique.len() == source_ids.len(),
        "Duplicate recording source"
    );
    let duration = args["durationSeconds"].as_u64().filter(|n| *n > 0);
    ensure!(
        duration.is_none_or(|n| n <= 86400),
        "Maximum take duration is 24 hours"
    );
    let folder = storage(args["directory"].as_str().unwrap_or(""))?;
    let directory = PathBuf::from(folder["path"].as_str().unwrap());
    let workers: Vec<_> = {
        let s = app.service.lock().unwrap();
        source_ids
            .iter()
            .map(|id| {
                s.workers
                    .get(id)
                    .cloned()
                    .ok_or_else(|| anyhow!("Monitor every selected input before recording"))
            })
            .collect::<Result<_>>()?
    };
    let bitrate = if profile == "prores" {
        148_000_000u64
    } else {
        103_000_000
    };
    let bytes_per_second: u64 = workers
        .iter()
        .map(|w| bitrate / 8 + w.config.source.audio_channels as u64 * 48_000 * 4)
        .sum();
    let free = folder["freeBytes"].as_str().unwrap().parse::<u64>()?;
    let reserve = 2u64 * 1024 * 1024 * 1024;
    ensure!(free>reserve+bytes_per_second*duration.unwrap_or(60),"Not enough free space for the selected inputs and duration, including finalization reserve");
    let mut confirmed = vec![];
    for w in &workers {
        let status = worker_call(app, w, "status", json!({})).await?;
        ensure!(
            status["ready"] == true,
            "{} is not ready: {}",
            w.config.source.name,
            status["error"]
                .as_str()
                .unwrap_or("waiting for video/audio")
        );
        confirmed.push(status);
    }
    let take_folder = directory.join(format!("{}_take-{}", file_stem(name), &id[..8]));
    fs::create_dir(&take_folder).context("Could not create a new take folder")?;
    let test = take_folder.join(".write-check");
    {
        let file = journal::private_file(&test, true)?;
        file.sync_all()?;
    }
    fs::remove_file(test)?;
    let (root, clock_id) = {
        let s = app.service.lock().unwrap();
        (s.directory.clone(), s.clock_id.clone())
    };
    let start = clock::ticks() + 2_000_000_000;
    let utc = clock::utc_ms() + 2000;
    let mut tracks = vec![];
    for w in &workers {
        let suffix = w
            .config
            .source
            .connector
            .map(|n| format!("SDI-{n:02}"))
            .unwrap_or_else(|| journal::hash(w.config.source.id.as_bytes())[..8].into());
        let folder = take_folder.join(format!("{}_{}", file_stem(&w.config.source.name), suffix));
        fs::create_dir(&folder)?;
        tracks.push(Track {
            source: w.config.source.clone(),
            folder,
            camera_ids: args["cameraMappings"][&w.config.source.id]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
        });
    }
    let mut take = Take {
        id: id.clone(),
        name: name.into(),
        directory: take_folder,
        started_utc: utc.to_string(),
        started_ticks: start.to_string(),
        session_clock_id: clock_id,
        ticks_per_second: "1000000000".into(),
        status: "preparing".into(),
        profile: profile.into(),
        duration_seconds: duration,
        tracks,
        stopped_ticks: None,
        show_run_id: None,
        errors: vec![],
        request_hash,
    };
    persist(&root, &take)?;
    {
        let mut s = app.service.lock().unwrap();
        s.markers
            .insert(id.clone(), MarkerStore::load(&marker_path(&root, &id))?);
        s.takes.insert(id.clone(), take.clone());
        s.active = Some(id.clone());
    }
    let mut jobs = tokio::task::JoinSet::new();
    for (w, track) in workers.iter().cloned().zip(take.tracks.clone()) {
        let app = app.clone();
        let take = take.clone();
        jobs.spawn(async move {
            worker_call(&app, &w, "record", json!({"take":take,"track":track})).await
        });
    }
    while let Some(result) = jobs.join_next().await {
        if let Err(e) = result? {
            take.errors.push(e.to_string());
        }
    }
    if !take.errors.is_empty() {
        for w in &workers {
            let _ = worker_call(app, w, "stop", json!({})).await;
        }
        take.status = "failed".into();
        take.stopped_ticks = Some(clock::ticks().to_string());
    } else {
        take.status = "recording".into();
    }
    persist(&root, &take)?;
    {
        let mut s = app.service.lock().unwrap();
        s.takes.insert(id.clone(), take.clone());
        if !take.active() {
            s.active = None;
        }
    }
    ensure!(
        take.recording(),
        "Could not start all selected inputs: {}",
        take.errors.join("; ")
    );
    Ok(json!(take))
}
async fn stop_take(app: &App) -> Result<Value> {
    let _op = app.op.lock().await;
    let (mut take, root, workers) = {
        let s = app.service.lock().unwrap();
        let Some(id) = &s.active else {
            return Ok(json!({"status":"idle"}));
        };
        let t = s.takes[id].clone();
        let workers = t
            .tracks
            .iter()
            .filter_map(|t| s.workers.get(&t.source.id).cloned())
            .collect::<Vec<_>>();
        (t, s.directory.clone(), workers)
    };
    let stop = clock::ticks() + 100_000_000;
    take.status = "finalizing".into();
    take.stopped_ticks = Some(stop.to_string());
    if let Err(e) = persist(&root, &take) {
        take.errors
            .push(format!("Recovery state write failed: {e}"));
    }
    app.service
        .lock()
        .unwrap()
        .takes
        .insert(take.id.clone(), take.clone());
    let mut jobs = tokio::task::JoinSet::new();
    for w in &workers {
        let app = app.clone();
        let w = w.clone();
        jobs.spawn(async move {
            worker_call(&app, &w, "stop", json!({"stopTicks":stop.to_string()})).await
        });
    }
    while let Some(result) = jobs.join_next().await {
        match result? {
            Ok(v) => {
                if let Some(e) = v["recordError"].as_str() {
                    take.errors.push(e.into());
                }
            }
            Err(e) => take.errors.push(e.to_string()),
        }
    }
    // A timed-out stop can still be in flight. Keep the take active until every worker confirms stopped.
    let mut uncertain = false;
    for w in &workers {
        match worker_call(app, w, "status", json!({})).await {
            Ok(v) => {
                if v["recording"] == true {
                    uncertain = true;
                }
            }
            Err(_) => {
                if process_alive(w.descriptor.pid) {
                    uncertain = true;
                }
            }
        }
    }
    if uncertain {
        take.status = "degraded".into();
        take.errors.push(
            "Some inputs have not confirmed they stopped. Retry Stop; do not shut down.".into(),
        );
    } else {
        take.status = if take.errors.is_empty() {
            "complete"
        } else {
            "partial"
        }
        .into();
    }
    if let Err(e) = persist(&root, &take) {
        take.errors
            .push(format!("Recovery state write failed: {e}"));
    }
    {
        let mut s = app.service.lock().unwrap();
        if let Some(m) = s.markers.get(&take.id) {
            if let Err(e) = markers::export(&take, &m.events) {
                s.export_errors.insert(take.id.clone(), e.to_string());
            }
        }
        s.takes.insert(take.id.clone(), take.clone());
        if !uncertain {
            s.active = None;
        }
    }
    Ok(json!(take))
}
fn process_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(windows)]
    {
        unsafe {
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::Threading::{
                    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
                },
            };
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code = 259;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok == 0 || code == 259
        }
    }
}
async fn watchdog(app: App) {
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let workers: Vec<_> = app
            .service
            .lock()
            .unwrap()
            .workers
            .values()
            .cloned()
            .collect();
        let mut checks = tokio::task::JoinSet::new();
        for w in workers {
            let app = app.clone();
            checks.spawn(async move {
            let status=worker_call(&app,&w,"status",json!({})).await.unwrap_or_else(|e|json!({"sourceId":w.config.source.id,"ready":false,"recording":false,"error":e.to_string(),"recordError":"Recording worker unavailable; partial files preserved"}));
            (w.config.source.id,status)
        });
        }
        while let Some(Ok((id, status))) = checks.join_next().await {
            if let Some(current) = app.service.lock().unwrap().workers.get_mut(&id) {
                current.status = status;
            }
        }
        let end = {
            let mut s = app.service.lock().unwrap();
            if let Some(id) = s.active.clone() {
                let take = s.takes[&id].clone();
                if take.recording() {
                    let faults: Vec<_> = take
                        .tracks
                        .iter()
                        .filter_map(|t| s.workers.get(&t.source.id))
                        .filter_map(|w| w.status["recordError"].as_str().map(str::to_string))
                        .collect();
                    if !faults.is_empty() {
                        let t = s.takes.get_mut(&id).unwrap();
                        t.status = "degraded".into();
                        for e in faults {
                            if !t.errors.contains(&e) {
                                t.errors.push(e);
                            }
                        }
                    }
                    let all_stopped = take.tracks.iter().all(|t| {
                        s.workers
                            .get(&t.source.id)
                            .is_none_or(|w| w.status["recording"] != true)
                    });
                    let disk_full = fs2::available_space(&take.directory)
                        .map(|n| n < 2 * 1024 * 1024 * 1024)
                        .unwrap_or(true);
                    all_stopped || disk_full
                } else {
                    false
                }
            } else {
                false
            }
        };
        if end {
            let _ = stop_take(&app).await;
        }
    }
}
