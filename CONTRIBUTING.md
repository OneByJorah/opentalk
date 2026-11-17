# Contributing

Thanks for helping! A few ground rules keep OpenTalk small and safe:

1. **Fork → branch → PR** against `main`. Keep PRs focused on one thing.
2. **Run the tests:** `npm install && npm test`. Add a test for any new server behavior.
3. **Keep it dependency-light.** The server has one runtime dependency (`ws`) and the frontend has none. Open an issue before adding any.
4. **Never render user content as HTML.** Use `textContent` and DOM nodes in the client, and validate everything on the server.
5. **No persistence by default.** OpenTalk's promise is that nothing is stored. Any feature that stores data must be opt-in through an env setting.
6. Code style: 2-space indent, semicolons, `'use strict'`, small functions.

Good first issues are labeled **good first issue**. Ideas are in the README roadmap.
