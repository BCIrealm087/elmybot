export function parseTwitchCommandText(messageText) {
  if (typeof messageText !== "string") return null;

  const normalized = messageText.trim();
  const match = normalized.match(/^!([^\s]+)(?:\s|$)/);
  if (!match) return null;

  return Object.freeze({
    name: match[1].toLowerCase(),
    argsText: normalized.slice(match[0].length).trim()
  });
}
