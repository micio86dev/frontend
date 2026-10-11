# Live verification scripts

## `tavus-steering-verify.mjs`

The live Tavus steering spike (SPIKE-01, L1-L8) behind `openspec/changes/tavus-single-session-interview`
(design Appendix A). It joins one existing Tavus conversation as a Daily participant (headless Chromium,
fake devices, video and mic off), sends data-channel interactions and prints a JSON summary.

**It spends real Tavus credits. Never run it without the owner's explicit authorization for that run.**
It is not imported by any test, and CI never runs it.

### Prerequisites

- Frontend dev dependencies installed (`bun install`): Playwright (`@playwright/test`) and `@daily-co/daily-js`.
  Playwright browsers must be installed (`bunx playwright install chromium`).
- A Tavus conversation created by the caller **from the api side**, so the Tavus key never reaches this
  process. The script takes only the conversation URL and id; it never creates or ends a conversation.
  - Create it from the api container (for example a short throwaway PHP/artisan snippet using the api's
    own Tavus client and configuration), and print only the `conversation_url` and `conversation_id`,
    never the key or the request headers. See design Appendix A for the persona/context used.
  - End it explicitly from the api side afterwards. A browser leave does not end the conversation
    (spike result L7), so an un-ended conversation keeps billing until Tavus times it out.

### Scenarios

Run with node (Playwright resolves from `frontend/node_modules`):

```sh
node scripts/live/tavus-steering-verify.mjs --scenario=steer --url=<conversation_url> --id=<conversation_id>
node scripts/live/tavus-steering-verify.mjs --scenario=leave --url=<conversation_url> --id=<conversation_id>
node scripts/live/tavus-steering-verify.mjs --scenario=observe --url=<conversation_url> --id=<conversation_id> --secs=300
```

| Scenario  | What it does                                                                                                                         | Gate          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `steer`   | respond / append / overwrite schedule (L1-L5), then keeps observing until `--secs` (L6)                                              | G-A, G-C      |
| `leave`   | joins, hears the greeting, leaves at `--leaveAfter` seconds (default 12); the caller then polls the conversation status from the api | G-D (also L7) |
| `observe` | joins and only logs, sends nothing (L6)                                                                                              | G-B           |

Gates are defined in `openspec/changes/tavus-single-session-interview/tasks.md` (each needs a separate owner go):
G-A multi-topic context obedience and the Q1 A/B, G-B plan-level cap and `max_call_duration`, G-C end phrase /
append / respond wording and ack latency, G-D explicit `participant_left_timeout` after the browser leaves.

### Output

- Console: one `[action]` line per host action, then `SUMMARY_JSON_FILE <path>` and the summary JSON.
- Summary: join result, timed actions, event-type counts, utterances (role, speech, turn), lifecycle events and
  non-utterance app messages. The conversation id is redacted to its last four characters and the room URL is
  never printed.
- File: `<out>/<scenario>-<epoch>.json` (summary plus raw app messages). `--out=<dir>` overrides the default
  `<os tmp dir>/tavus-steering-spike`, a directory outside the repository, so nothing is written under the repo and
  no `.gitignore` entry is needed. If you point `--out` inside the repo, ignore it first.

### History

Recovered from the transcript of the agent that wrote it for the 2026-10-09 spike; the committed file may
differ from the copy used in that run by tiny later edits, if any were made. Lint-only changes since: merged
duplicate `node:fs` imports, dropped an unused `here` constant, removed a dead initial assignment, and gave an
empty `catch` an explanatory comment.
