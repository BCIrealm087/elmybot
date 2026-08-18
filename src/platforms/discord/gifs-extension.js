export const evalGifOptions = (options) => {
  const searchString = options.extraData.gif;
  if (searchString === null || searchString === undefined) return null;
  return searchString.length === 0 ? "Search string cannot be empty."
  : searchString.length > 20 ? "Search string too long (max 20 chars)."
  : null;
}

export const gifMessageInnerContent = (j) => `\`${j.subject}\` (with \`${j.extraData.gif}\` gif)`;
export const gifMessageOuterContent = (j, __) => j.subject;

export const gifMessageCompose = async (c, env, stored) => {
  const q = String(stored.extraData.gif ?? "").trim();
  if (!q) throw new Error("Empty search string was provided.");

  const url = new URL("https://api.klipy.com/v2/search");
  url.searchParams.set("q", q);
  url.searchParams.set("key", env.KLIPY_API_KEY);
  url.searchParams.set("client_key", env.KLIPY_API_KEY_NAME);
  url.searchParams.set("limit", "50"); // KLIPY MAX, setting to 1 makes random function not work
  url.searchParams.set("random", "true");
  url.searchParams.set("media_filter", "gif");

  const r = await fetch(url);

  if (!r.ok) {
    throw new Error(`KLIPY API error ${r.status}: ${await r.text()}`);
  }

  const data = await r.json();
  const result = data?.results?.[0];

  if (!result) throw new Error(`No GIF found for \`${q}\`.`);

  const gifUrl =
    result.media_formats?.gif?.url ??
    result.media_formats?.mediumgif?.url ??
    null;

  if (!gifUrl) {
    throw new Error(`Found a GIF for \`${q}\`, but no usable media URL was returned.`);
  }

  const IC = c.innerContent(stored);
  const AM = c.allowedMentions(stored);
  const OC = c.outerContent(stored, IC);

  return {
    allowed_mentions: AM,
    content: OC,
    embeds: [{ image: { url: gifUrl } }]
  };

}