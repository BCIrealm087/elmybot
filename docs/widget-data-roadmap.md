# Widget-data roadmap (superseded)

The original roadmap delivered widget-data as queryable replacement state. That
surface was intentionally migrated to bounded at-least-once event delivery on
2026-09-27.

Current planning and completion evidence live in
[Durable feature-event delivery: development roadmap](durable-event-transport-roadmap.md).
The active consumer and contributor instructions are in the
[widget-data durable event guide](widget-data.md).

The migration preserved both command names, moderator authorization, parsing,
input limits, cooldown, and platform parity. It did not convert old replacement
values or state-query grants. This historical path is retained to avoid broken
documentation links; the previous staged plan is no longer authoritative.
