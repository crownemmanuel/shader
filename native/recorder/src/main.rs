#[cfg(feature = "media")]
mod media;
mod recovery;
mod service;
mod worker;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let value = |name: &str| args.windows(2).find(|a| a[0] == name).map(|a| a[1].clone());
    #[cfg(feature = "media")]
    gstreamer::init()?;
    if args.iter().any(|a| a == "--worker") {
        let path = value("--config").ok_or_else(|| anyhow::anyhow!("Worker config required"))?;
        return worker::run(serde_json::from_slice(&std::fs::read(path)?)?).await;
    }
    if args.iter().any(|a| a == "--capabilities") {
        println!("{}", worker::capabilities());
        return Ok(());
    }
    let directory = value("--data-dir")
        .map(std::path::PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("--data-dir required"))?;
    service::run(directory).await
}
