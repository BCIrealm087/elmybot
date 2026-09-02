export {
  initializeShareableStateRealmTables,
  SHAREABLE_STATE_REALM_PATH_PREFIX,
  SHAREABLE_STATE_REALM_SCHEMA_VERSION,
  SHAREABLE_STATE_SNAPSHOT_FORMAT_VERSION,
  ShareableStateRealmBackend,
  ShareableStateRealmError
} from "./realm.js";
export {
  cloneShareableStateSnapshot,
  createIntegrationRealmIdentity,
  createStandaloneRealmIdentity,
  requestShareableStateRealm,
  requestStandaloneRealmState,
  shareableStateSnapshotHasMeaningfulState,
  shareableStateSnapshotsEqual,
  shareableStateRealmObjectName,
  shareableStateRealmStub,
  snapshotShareableStateNamespace,
  standaloneRealmObjectName,
  standaloneRealmStub
} from "./realm-client.js";
