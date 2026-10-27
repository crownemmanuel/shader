//! Recover checkpointed media into a new file. Originals are never overwritten.
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use shader_recorder::{journal, model::Take};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub fn recover(take: &Take) -> Result<Value> {
    ensure!(
        !take.active(),
        "Stop and finalize this take before recovery"
    );
    let ffmpeg = std::env::var_os("SHADER_FFMPEG")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file())
        .context("The installed FFmpeg recovery tool is unavailable")?;
    let mut results = vec![];
    for track in &take.tracks {
        for entry in fs::read_dir(&track.folder)? {
            let entry = entry?;
            let input = entry.path();
            if !entry.file_type()?.is_file() || !input.to_string_lossy().ends_with(".mov.partial") {
                continue;
            }
            let final_path = input.with_extension("").with_extension("recovered.mov");
            if final_path.exists() {
                results.push(json!({"original":input,"recovered":final_path,"status":"already-exists-review"}));
                continue;
            }
            let work = input.with_extension(format!("{}.repairing", uuid::Uuid::new_v4()));
            let log = input.with_extension("recovery.log");
            let progress = input.with_extension("recovery-progress.txt");
            let mut command = Command::new(&ffmpeg);
            command
                .args([
                    "-nostdin",
                    "-hide_banner",
                    "-v",
                    "error",
                    "-progress",
                    "pipe:1",
                    "-nostats",
                    "-n",
                    "-i",
                ])
                .arg(&input)
                .args(["-map", "0", "-c", "copy", "-f", "mov"])
                .arg(&work)
                .stdin(Stdio::null())
                .stdout(Stdio::from(journal::private_file(&progress, false)?))
                .stderr(Stdio::from(journal::private_file(&log, false)?));
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let mut child = command.spawn()?;
            let deadline = Instant::now() + Duration::from_secs(1800);
            let status = loop {
                if let Some(s) = child.try_wait()? {
                    break Some(s);
                }
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                thread::sleep(Duration::from_millis(100));
            };
            let frames = fs::read_to_string(&progress)
                .unwrap_or_default()
                .lines()
                .filter_map(|l| {
                    l.strip_prefix("frame=")
                        .and_then(|n| n.trim().parse::<u64>().ok())
                })
                .max()
                .unwrap_or(0);
            if frames > 0
                && status.is_some_and(|s| s.success())
                && fs::metadata(&work).is_ok_and(|m| m.len() > 0)
            {
                fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&work)?
                    .sync_all()?;
                fs::rename(&work, &final_path)?;
                results.push(json!({"original":input,"recovered":final_path,"status":"recovered-checkpoint","frames":frames,"reviewRequired":true}));
            } else {
                results.push(json!({"original":input,"status":"could-not-recover","log":log,"reviewRequired":true}));
            }
        }
    }
    let report = json!({"recordingSessionId":take.id,"results":results,"note":"Original partial files preserved. Recovery can include only committed media; inspect duration, audio and synchronization before editing."});
    journal::atomic_json(&take.directory.join("recovery-report.json"), &report)?;
    Ok(report)
}
