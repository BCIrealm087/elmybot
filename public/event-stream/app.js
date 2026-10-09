import {
  createDurableEventClient,
  createRecentEventIdDeduplicator
} from "./client.js";
import { mountDurableEventApp } from "./ui.js";

mountDurableEventApp(
  window,
  document,
  createDurableEventClient,
  createRecentEventIdDeduplicator
);
