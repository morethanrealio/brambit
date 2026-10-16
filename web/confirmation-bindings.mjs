// Capture only user-editable configuration; a scheduler heartbeat must not
// invalidate a human proposal. These values also feed updateRoutine's SQL guard.
export function routineConfirmationSnapshot(row) {
  const { execution, ...config } = row.config || {};
  return JSON.parse(JSON.stringify({ config, prompt:row.prompt, channel:row.channel,
    hour:row.hour, minute:row.minute, days:row.days, tz:row.tz, enabled:row.enabled, title:row.title,
    repeat_every_min:row.repeat_every_min, repeat_until:row.repeat_until }));
}
