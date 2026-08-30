# `@elmybot/feature-alive`

Private npm-workspace proof for an Elmybot build-time feature package. It owns
the shared Discord `/alive` and Twitch `!alive` feature and imports only the
stable `@elmybot/framework` API.

The package is reviewed, installed explicitly, and bundled with the Worker. It
is not loaded dynamically at runtime.
