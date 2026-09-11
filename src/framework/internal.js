// Composition-root and platform-adapter APIs. Contributor feature modules must
// import from `./index.js` instead; this module has no compatibility guarantee.
export * from "./index.js";
export {
  createFeatureRegistry,
  FeatureRegistryError,
  mergeCommandDefinitions
} from "./feature-registry.js";
export { discordOptionDescriptor } from "./discord.js";
export { parseTwitchCommandText } from "./twitch-command-text.js";
