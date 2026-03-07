/**
 * Helper to pull a single option value by name from an interaction.
 */
export function getOption(interaction, name) {
  const opts = interaction.data?.options ?? [];
  return opts.find(o => o.name === name)?.value;
}

/**
 * Build a JSON response with the expected Discord response headers.
 */
export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function ephemeralData(content) {
  return { content, flags: 64, allowed_mentions: { parse: [] } };
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