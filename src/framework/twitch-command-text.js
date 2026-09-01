// Chat clients such as 7TV may append invisible characters to repeated
// messages so Twitch does not reject them as duplicates. They are transport
// artifacts when they appear at the end of command text, not command args.
const DUPLICATE_MESSAGE_BYPASS_SUFFIX =
  /(?:[\u034F\u{E0000}-\u{E007F}]\s*)+$/u;

export function parseTwitchCommandText(messageText) {
  if (typeof messageText !== "string") return null;

  const normalized = messageText
    .trim()
    .replace(DUPLICATE_MESSAGE_BYPASS_SUFFIX, "")
    .trim();
  const match = normalized.match(/^!([^\s]+)(?:\s|$)/);
  if (!match) return null;

  return Object.freeze({
    name: match[1].toLowerCase(),
    argsText: normalized.slice(match[0].length).trim()
  });
}
