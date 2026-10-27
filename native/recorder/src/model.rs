use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub name: String,
    pub device: String,
    #[serde(default)]
    pub card_id: Option<String>,
    #[serde(default)]
    pub connector: Option<u32>,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_audio")]
    pub audio_channels: u32,
    #[serde(default)]
    pub simulated: bool,
}
fn default_mode() -> String {
    "1080p30".into()
}
fn default_audio() -> u32 {
    16
}
impl Source {
    pub fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.id.is_empty() && self.id.len() <= 300,
            "Invalid source ID"
        );
        anyhow::ensure!(
            !self.name.trim().is_empty() && self.name.chars().count() <= 120,
            "Enter an input name of at most 120 characters"
        );
        anyhow::ensure!(
            [2, 8, 16].contains(&self.audio_channels),
            "Choose 2, 8 or 16 audio channels"
        );
        anyhow::ensure!(
            ["1080p30", "1080p2997"].contains(&self.mode.as_str()),
            "Recorder currently supports 1080p30 and 1080p29.97"
        );
        if !self.simulated {
            self.persistent_id()?;
        }
        Ok(())
    }
    pub fn persistent_id(&self) -> anyhow::Result<i64> {
        let rest = self.device.strip_prefix("pid:").ok_or_else(|| {
            anyhow::anyhow!("Rediscover this DeckLink input to obtain its persistent ID")
        })?;
        let (id, sub) = rest
            .split_once(":sub:")
            .ok_or_else(|| anyhow::anyhow!("Invalid DeckLink identity"))?;
        anyhow::ensure!(sub.parse::<u32>().is_ok(), "Invalid subdevice");
        Ok(u64::from_str_radix(id, 16)? as i64)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub source: Source,
    pub folder: PathBuf,
    pub camera_ids: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Take {
    pub id: String,
    pub name: String,
    pub directory: PathBuf,
    pub started_utc: String,
    pub started_ticks: String,
    pub session_clock_id: String,
    pub ticks_per_second: String,
    pub status: String,
    pub profile: String,
    pub duration_seconds: Option<u64>,
    pub tracks: Vec<Track>,
    pub stopped_ticks: Option<String>,
    pub show_run_id: Option<String>,
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(default)]
    pub request_hash: String,
}
impl Take {
    pub fn active(&self) -> bool {
        matches!(
            self.status.as_str(),
            "preparing" | "recording" | "degraded" | "finalizing"
        )
    }
    pub fn recording(&self) -> bool {
        matches!(self.status.as_str(), "recording" | "degraded")
    }
}
pub fn file_stem(name: &str) -> String {
    let value: String = name
        .trim()
        .chars()
        .take(70)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let value = value.trim_matches([' ', '.']).to_string();
    let root = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    if value.is_empty() {
        "Camera".into()
    } else if [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .contains(&root.as_str())
    {
        format!("Camera-{value}")
    } else {
        value
    }
}
