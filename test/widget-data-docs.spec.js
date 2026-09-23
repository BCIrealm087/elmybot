import { describe, expect, it } from "vitest";
import readme from "../README.md?raw";
import browserGuide from "../docs/state-query-browser.md?raw";
import guide from "../docs/widget-data.md?raw";

describe("widget-data guidance", () => {
  it("documents the complete consumer contract", () => {
    for (const required of [
      "/widget_data data:<text>",
      "!widgetdata <text...>",
      "widget.data:latest:v1",
      '"state": "absent"',
      '"state": "present"',
      "transitioning",
      "unavailable",
      "updateId",
      "queryDigest",
      "resultRevision",
      "bindingRevision",
      "A: ",
      "B: ",
      "C: ",
      "textContent",
      "acknowledges after callbacks return"
    ]) {
      expect(guide).toContain(required);
    }
    expect(guide).toContain("may be coalesced");
    expect(guide).toContain("does not guarantee");
    expect(guide).toContain("not a");
    expect(guide).toContain("event stream");
  });

  it("keeps credentials, queries, and cursors out of URLs", () => {
    expect(guide).not.toMatch(
      /(?:https?|wss?):\/\/[^\s)\]"']*[?&](?:credential|grant|query|cursor)=/i
    );
    expect(guide).not.toMatch(
      /\/state-query\/(?:snapshot|socket)[?][^\s)\]"']+/i
    );
    expect(guide).toContain("The URL has no query parameters.");
  });

  it("is linked from user, browser, and generated catalog guidance", () => {
    expect(readme).toContain("[Widget-data consumer and contributor guide](docs/widget-data.md)");
    expect(browserGuide).toContain("[widget-data guide](widget-data.md)");
  });
});
