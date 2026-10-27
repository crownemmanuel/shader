use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

#[derive(Serialize, Deserialize)]
struct Record {
    checksum: String,
    value: Value,
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn private_file(path: &Path, create_new: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).read(true);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    Ok(options.open(path)?)
}
/// Only a torn final record can be discarded. Corruption in the middle fails closed.
pub fn read(path: &Path) -> Result<Vec<Value>> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let mut file = OpenOptions::new().read(true).write(true).open(path)?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let mut rows = Vec::new();
    let mut consumed = 0usize;
    for line in bytes.split_inclusive(|b| *b == b'\n') {
        if !line.ends_with(b"\n") {
            file.set_len(consumed as u64)?;
            file.sync_all()?;
            break;
        }
        let record: Record = serde_json::from_slice(line)
            .context("Recorder journal is corrupt; original files were preserved")?;
        if hash(&serde_json::to_vec(&record.value)?) != record.checksum {
            bail!("Recorder journal checksum mismatch; original files were preserved");
        }
        rows.push(record.value);
        consumed += line.len();
    }
    Ok(rows)
}
pub fn append(path: &Path, value: &Value) -> Result<()> {
    let mut file = private_file(path, false)?;
    let start = file.seek(SeekFrom::End(0))?;
    let record = Record {
        checksum: hash(&serde_json::to_vec(value)?),
        value: value.clone(),
    };
    let mut bytes = serde_json::to_vec(&record)?;
    bytes.push(b'\n');
    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
        // Preserve the previous committed prefix where rollback is still possible.
        let _ = file.set_len(start);
        let _ = file.sync_all();
        return Err(error.into());
    }
    Ok(())
}
pub fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = private_file(&temp, true)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    drop(file);
    replace(&temp, path)?;
    #[cfg(unix)]
    {
        if let Some(parent) = path.parent() {
            File::open(parent)?.sync_all()?;
        }
    }
    Ok(())
}
fn replace(from: &Path, to: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let a: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                a.as_ptr(),
                b.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Ok(std::fs::rename(from, to)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovers_torn_tail_and_keeps_committed_prefix() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("events");
        append(&p, &serde_json::json!({"id":1})).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&p)
            .unwrap()
            .write_all(b"{torn")
            .unwrap();
        assert_eq!(read(&p).unwrap(), vec![serde_json::json!({"id":1})]);
        append(&p, &serde_json::json!({"id":2})).unwrap();
        assert_eq!(read(&p).unwrap().len(), 2);
    }
    #[test]
    fn corruption_is_not_silently_skipped() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("events");
        std::fs::write(&p, b"{bad}\n").unwrap();
        assert!(read(&p).is_err());
    }
}
