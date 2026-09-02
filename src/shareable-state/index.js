export {
  initializeShareableStateRealmTables,
  SHAREABLE_STATE_REALM_PATH_PREFIX,
  SHAREABLE_STATE_REALM_SCHEMA_VERSION,
  ShareableStateRealmBackend,
  ShareableStateRealmError
} from "./realm.js";
export {
  createIntegrationRealmIdentity,
  createStandaloneRealmIdentity,
  requestShareableStateRealm,
  requestStandaloneRealmState,
  shareableStateRealmObjectName,
  shareableStateRealmStub,
  standaloneRealmObjectName,
  standaloneRealmStub
} from "./realm-client.js";
