export async function putDiscordCommands({
  appId,
  token,
  commandDescriptors,
  fetchImpl = fetch,
  log = console.log
}) {
  const url = `https://discord.com/api/v10/applications/${appId}/commands`;
  const response = await fetchImpl(url, {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commandDescriptors),
  });
  const responseText = await response.text();

  log(response.status, responseText);
  if (!response.ok) {
    throw new Error(`Discord command registration failed with status ${response.status}.`);
  }

  return { status: response.status, responseText };
}
