#[cfg(feature = "media")]
use crate::service::Descriptor;
use crate::service::WorkerConfig;
use anyhow::Result;
use serde_json::{json, Value};
#[cfg(feature = "media")]
use {
    axum::{
        extract::{DefaultBodyLimit, State},
        http::{HeaderMap, StatusCode},
        routing::post,
        Json, Router,
    },
    std::sync::{Arc, Mutex},
    tokio::net::TcpListener,
};

pub fn capabilities() -> Value {
    #[cfg(feature = "media")]
    {
        crate::media::capabilities()
    }
    #[cfg(not(feature = "media"))]
    {
        json!({"available":false,"error":"This recorder build does not include the media runtime"})
    }
}
#[cfg(feature = "media")]
pub async fn run(config: WorkerConfig) -> Result<()> {
    use fs2::FileExt;
    let lock =
        shader_recorder::journal::private_file(&config.directory.join("worker.lock"), false)?;
    lock.try_lock_exclusive()?;
    let capture = crate::media::Capture::open(config.clone())?;
    let state = Arc::new(Mutex::new(capture));
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let descriptor = Descriptor {
        url: format!("http://{}", listener.local_addr()?),
        token: config.token.clone(),
        pid: std::process::id(),
    };
    shader_recorder::journal::atomic_json(&config.directory.join("worker.json"), &descriptor)?;
    let tick = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let copy = tick.clone();
            let _ = tokio::task::spawn_blocking(move || copy.lock().unwrap().tick()).await;
        }
    });
    async fn rpc(
        State(state): State<Arc<Mutex<crate::media::Capture>>>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> (StatusCode, Json<Value>) {
        let expected = { format!("Bearer {}", state.lock().unwrap().config.token) };
        if headers.get("origin").is_some()
            || headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(&expected)
        {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":"Unauthorized"})),
            );
        }
        let output = tokio::task::spawn_blocking(move || {
            state.lock().unwrap().command(
                body["name"].as_str().unwrap_or(""),
                body.get("args").cloned().unwrap_or(json!({})),
            )
        })
        .await;
        match output {
            Ok(Ok(v)) => (StatusCode::OK, Json(v)),
            Ok(Err(e)) => (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":e.to_string()})),
            ),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error":e.to_string()})),
            ),
        }
    }
    axum::serve(
        listener,
        Router::new()
            .route("/rpc", post(rpc))
            .layer(DefaultBodyLimit::max(128 * 1024))
            .with_state(state),
    )
    .await?;
    Ok(())
}
#[cfg(not(feature = "media"))]
pub async fn run(_config: WorkerConfig) -> Result<()> {
    anyhow::bail!("Media runtime is not included")
}
