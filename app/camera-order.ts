/** Saved ordering can contain disconnected cameras; newly discovered cameras follow it. */
export function orderedCameraIds(saved: string[], current: string[]) {
  const available = new Set(current);
  return [...new Set([...saved, ...current])].filter((id) => available.has(id));
}
export function moveCameraId(
  saved: string[],
  current: string[],
  id: string,
  target: string,
  after = false,
) {
  const order = [...new Set([...saved, ...current])];
  if (id === target || !current.includes(id) || !current.includes(target))
    return order;
  const result = order.filter((x) => x !== id);
  result.splice(result.indexOf(target) + (after ? 1 : 0), 0, id);
  return result;
}
