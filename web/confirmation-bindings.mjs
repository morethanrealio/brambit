// Capture only what a proposal can change; a scheduler heartbeat or an
// adjustment noted meanwhile (routine-adjustments.mjs) must not invalidate it.
// These values also feed updateRoutine's SQL guard.
export function routineConfirmationSnapshot(row) {
  const { execution, adjustments, ...config } = row.config || {};
  return JSON.parse(JSON.stringify({ config, prompt:row.prompt, channel:row.channel,
    hour:row.hour, minute:row.minute, days:row.days, tz:row.tz, enabled:row.enabled, title:row.title,
    repeat_every_min:row.repeat_every_min, repeat_until:row.repeat_until }));
}
