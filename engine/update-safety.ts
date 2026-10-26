/** Restart guard shared by the updater and tests; never changes camera state. */
export function updateInstallBlocker(
  status: {
    cameras: { writing: boolean }[];
    presetJobs: { status: string }[];
  },
  now = Date.now(),
): string | null {
  if (status.cameras.some((camera) => camera.writing))
    return "Wait for camera changes to finish before installing an update.";
  if (
    status.presetJobs.some((job) => ["queued", "running"].includes(job.status))
  )
    return "Wait for camera preset recalls to finish before installing.";
  return null;
}
