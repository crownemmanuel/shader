import test from "node:test";
import assert from "node:assert/strict";
import { updateInstallBlocker } from "../update-safety.js";

test("update restart refuses in-flight camera writes and pending recalls, including state changed during a download", () => {
  const status = {
    cameras: [{ writing: false }],
    presetJobs: [{ status: "applied" }],
  };
  assert.equal(updateInstallBlocker(status, 100), null);
  status.cameras[0].writing = true;
  assert.match(updateInstallBlocker(status, 100)!, /changes to finish/);
  status.cameras[0].writing = false;
  assert.equal(updateInstallBlocker(status, 200), null);
  for (const phase of ["queued", "running"]) {
    status.presetJobs[0].status = phase;
    assert.match(updateInstallBlocker(status, 200)!, /recalls to finish/);
  }
  for (const phase of ["applied", "failed", "cancelled"]) {
    status.presetJobs[0].status = phase;
    assert.equal(updateInstallBlocker(status, 200), null);
  }
});
