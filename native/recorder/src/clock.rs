use std::time::{SystemTime, UNIX_EPOCH};
pub const RATE: u64 = 1_000_000_000;
pub fn utc_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
/// A host monotonic domain shared by independently running capture workers.
pub fn ticks() -> u64 {
    #[cfg(feature = "media")]
    {
        use gstreamer::prelude::*;
        static INIT: std::sync::OnceLock<()> = std::sync::OnceLock::new();
        INIT.get_or_init(|| gstreamer::init().expect("GStreamer clock initialization failed"));
        gstreamer::SystemClock::obtain().time().nseconds()
    }
    #[cfg(all(not(feature = "media"), unix))]
    unsafe {
        let mut t: libc::timespec = std::mem::zeroed();
        libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut t);
        t.tv_sec as u64 * RATE + t.tv_nsec as u64
    }
    #[cfg(all(not(feature = "media"), windows))]
    unsafe {
        use windows_sys::Win32::System::Performance::{
            QueryPerformanceCounter, QueryPerformanceFrequency,
        };
        let (mut counter, mut frequency) = (0, 0);
        QueryPerformanceCounter(&mut counter);
        QueryPerformanceFrequency(&mut frequency);
        (counter as u128 * RATE as u128 / frequency as u128) as u64
    }
}
