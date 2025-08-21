export function toIsoUTC(date: Date | string | number) {
  const d = new Date(date);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

export function isFuture(iso: string) {
  return new Date(iso).getTime() > Date.now();
}

export function formatLabel(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
