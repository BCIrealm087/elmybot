import { createStateQueryClient } from "./client.js";
import { createStateQueryTools } from "./query.js";
import { mountStateQueryApp } from "./ui.js";

mountStateQueryApp(window, document, createStateQueryClient, createStateQueryTools);
