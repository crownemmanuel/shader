import { invoke, isTauri } from "@tauri-apps/api/core";
export async function command<T = any>(
  name: string,
  args: unknown = {},
): Promise<T> {
  if (isTauri()) return invoke<T>("camera_command", { name, args });
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, args }),
  });
  const body = await response.json();
  if (body.error) throw new Error(body.error);
  return body.result;
}
