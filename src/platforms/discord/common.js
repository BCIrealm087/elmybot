export { jsonResponse } from "../../common.js";

/**
 * Helper to pull a single option value by name from an interaction.
 */
export function getOption(interaction, name) {
  const opts = interaction.data?.options ?? [];
  return opts.find(o => o.name === name)?.value;
}

export function ephemeralData(content) {
  return (content === null || content === undefined)
    ? { flags: 64, allowed_mentions: { parse: [] } }
    : { content, flags: 64, allowed_mentions: { parse: [] } }
}

/**
 * Generate an ephemeral response (visible only to the invoking user).
 */
export function ephemeral(content) {
  return jsonResponse({
    type: 4,
    data: ephemeralData(content),
  });
}

export function formatInterval(seconds) {
  if (seconds >= 3600) {
    return `${(seconds / 3600).toFixed(1)}h`;
  }

  if (seconds >= 60) {
    return `${(seconds / 60).toFixed(1)}min`;
  }

  return `${seconds}s`;
}