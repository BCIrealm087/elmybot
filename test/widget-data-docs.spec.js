import { describe, expect, it } from "vitest";
import readme from "../README.md?raw";
import browserGuide from "../docs/durable-event-browser.md?raw";
import guide from "../docs/widget-data.md?raw";

describe("widget-data guidance", () => {
  it("documents the complete consumer contract", () => {
    for (const required of [
      "/widget_data data:<text>",
      "!widgetdata <text...>",
      "widget.data:updates:v1",
      "Widget event queued.",
      "eventId",
      "sequence",
      "at least once",
      "replays",
      "stream_moved",
      "eventStreams.current",
      "published_data"
    ]) {
      expect(guide).toContain(required);
    }
    expect(guide).toContain("does not parse JSON");
    expect(guide).toContain("cannot promise exactly-once");
    expect(guide).toMatch(/not replacement\s+state/);
    expect(guide).toContain("not converted");
  });

  it("keeps credentials, queries, and cursors out of URLs", () => {
    expect(guide).not.toMatch(
      /(?:https?|wss?):\/\/[^\s)\]"']*[?&](?:credential|grant|query|cursor)=/i
    );
    expect(guide).not.toMatch(
      /\/event-stream\/(?:catalog|socket|widget)[?][^\s)\]"']+/i
    );
    expect(guide).toContain("contains no credential or query parameter");
  });

  it("is linked from user, browser, and generated catalog guidance", () => {
    expect(readme).toContain("[Widget-data consumer and contributor guide](docs/widget-data.md)");
    expect(browserGuide).toContain("[widget-data guide](widget-data.md)");
  });
});
