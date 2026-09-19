const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const UPDATE_ID_CONTEXT = "widget.data.update.v1";
const UPDATE_ID_PREFIX = "wdu1.";
const ACTION_KIND = "widget.data.publish.v1";

function requiredIdentityPart(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function encodeBase64Url(bytes) {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];

    encoded += BASE64URL_ALPHABET[first >> 2];
    encoded += BASE64URL_ALPHABET[
      ((first & 0b11) << 4) | ((second ?? 0) >> 4)
    ];
    if (second !== undefined) {
      encoded += BASE64URL_ALPHABET[
        ((second & 0b1111) << 2) | ((third ?? 0) >> 6)
      ];
    }
    if (third !== undefined) encoded += BASE64URL_ALPHABET[third & 0b111111];
  }
  return encoded;
}

export async function deriveWidgetDataUpdateId({
  originGroupKey,
  sourceEventId
} = {}) {
  const serialized = JSON.stringify([
    UPDATE_ID_CONTEXT,
    ACTION_KIND,
    requiredIdentityPart(originGroupKey, "originGroupKey"),
    requiredIdentityPart(sourceEventId, "sourceEventId")
  ]);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest(
    "SHA-256",
    new globalThis.TextEncoder().encode(serialized)
  ));
  return UPDATE_ID_PREFIX + encodeBase64Url(digest);
}
