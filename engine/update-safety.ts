/** Restart guard shared by the updater and tests; never changes camera state. */
export function updateInstallBlocker(
  status: {
    recorder?: { active?: unknown; available?: boolean };
    cameras: { writing: boolean }[];
    presetJobs: { status: string }[];
  },
  now = Date.now(),
): string | null {
  if (status.recorder?.active)
    return "Stop and finalize the recording before installing an update.";
  if (status.cameras.some((camera) => camera.writing))
    return "Wait for camera changes to finish before installing an update.";
  if (
    status.presetJobs.some((job) => ["queued", "running"].includes(job.status))
  )
    return "Wait for camera preset recalls to finish before installing.";
  return null;
}
