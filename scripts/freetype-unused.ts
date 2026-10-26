// Shader exposes camera controls only; ATEM multiview label rasterization is not
// part of its public command registry. Avoid shipping an unused native addon.
export function NewMemoryFace(): never {
  throw new Error(
    "Multiview font rendering is not part of the Shader camera engine",
  );
}
