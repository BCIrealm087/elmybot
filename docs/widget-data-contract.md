# Widget-data contract (superseded)

The original widget-data replacement-state contract was superseded on
2026-09-27 by the durable-event version-2 contract.

The current normative identities and behavior are defined in
[Durable event delivery contract](durable-event-contract.md), under
“Widget-data version-2 contract.” The operator and contributor instructions are
in the [widget-data durable event guide](widget-data.md).

Migration summary:

- `/widget_data` and `!widgetdata` keep their names, moderator access, parsing,
  1–400-unit input bound, and one-second group cooldown.
- The authoritative consumer surface is now `widget.data:updates:v1`.
- The action kind is now `widget.data.emit.v2`.
- The success response is `Widget event queued.`.
- `widget.data:latest:v1`, `published_data`, and its `latest` key are retired
  product surfaces.
- Existing state-query grants do not authorize the event stream.
- Previously stored replacement values remain inert; the migration neither
  emits them as events nor deletes them.

This file remains at its historical path so old links resolve, but it is not a
second normative contract.
