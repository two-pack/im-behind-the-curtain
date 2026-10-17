# Storage format

`imbehind serve` keeps every request as a small folder of JSON files. The files are the only state: nothing is hidden in memory that a restart would lose. Any tool can read them, and a tool can also write a reply, instead of using `imbehind answer`. This document is the contract for that. It describes format version 2 of `request.json` and format version 1 of the other files.

`imbehind path` prints the storage directory (see the specification for the default and for how to choose it).

## Layout

```
<storage directory>/
  serve.lock
  requests/
    <request id>/
      request.json
      state.json
      reply.json
      reply.accepted.json
```

- `serve.lock` belongs to `imbehind serve`. Do not read or write it.
- A request id looks like `20261009T140512123Z-a1b2c3`: the time the request arrived (UTC), a dash, and six hex digits. The log lines and the screens of `imbehind answer` show only the last six digits, the short id. Ids sort in the order the requests arrived.
- `request.json` and `state.json` are written by `imbehind serve`. A tool may read them and must never write them.
- `reply.json` is where a reply is put, by `imbehind answer` or by a tool (see "Writing a reply file"). When `imbehind serve` accepts it, the content is kept as `reply.accepted.json` and `reply.json` is removed. A request that was ended by an invalid reply keeps its `reply.json` (see "When the reply file is not valid").
- Files and folders whose names start with a dot are temporary or belong to other programs. Leave them alone. Finished requests are deleted with their folder after the retention time (see the README).

## Format version

Every file has the field `formatVersion`, a whole number. The `formatVersion` of `request.json` is `2`. The `formatVersion` of `state.json` and `reply.json` stay at `1`. A reader must treat a file with a `formatVersion` it does not know as a file it does not understand. `imbehind serve` does so for `reply.json` (reason `reply file has an unknown format version`).

- This version reads both `1` and `2` for `request.json`. A request file of version 1, written by an older version, has no `toolDefinitions` field, and it is read as if `toolDefinitions` were `none`.
- This version writes version 2 for every request, not only for requests that have tools.
- An older version of `imbehind` that knows only version 1 treats a version 2 `request.json` as a file it cannot read: its `imbehind answer` does not list these requests, and its `imbehind serve` reports them as unreadable. Any tool of yours that reads `request.json` must accept `2` as well as `1`.
- A version 2 file whose `toolDefinitions` is missing or is not one of the four values below is not readable.

## request.json

| Field | Type | Meaning |
|---|---|---|
| `formatVersion` | number | `2`. A file written by an older version has `1`. |
| `id` | string | The request id. |
| `receivedAt` | string | When the request arrived, as an ISO 8601 UTC time. |
| `format` | string | The API format of the request. `chat.completions`. |
| `model` | string | The `model` the client sent. |
| `replyKind` | string | What the human has to write: `text`, or `json` when the client asked for structured output. |
| `requiredShape` | object or null | The JSON Schema the client asked for, or `null`. It is shown to the human and is not checked. |
| `stream` | boolean | The client asked for a stream. |
| `includeUsage` | boolean | The client asked for the usage chunk of a stream. |
| `toolDefinitions` | string | Which definitions the request carries: `tools`, `functions`, `both` or `none`. An empty array counts as no definition. It decides how a reply is told from tool calls. |
| `conversation` | array | The messages, each `{ "role": "system" \| "developer" \| "user" \| "assistant" \| "tool" \| "function", "content": string }` and, only when the client sent them, the tool fields below. |
| `originalRequest` | object | The body the client sent, as it arrived, `tools` and `functions` included. |

### Tool fields of a message

A message in `conversation` can also have `tool_call_id`, `name`, `tool_calls` and `function_call`. A field is there only when the client sent it, and its value is stored exactly as received, with whatever type the client used. Nothing is checked or changed, so a form that is wrong (a `tool_calls` that is not an array, a `function_call` that is a string) is stored too, and `imbehind answer` shows it as `(unreadable tool call)`. A `content` that was `null` or missing is stored as an empty string. A message that the client sent without these fields has only `role` and `content`.

## state.json

| Field | Type | Meaning |
|---|---|---|
| `formatVersion` | number | `1` |
| `id` | string | The request id. |
| `state` | string | `waiting` until the request ends, then one of `replied`, `skipped`, `cancelled`, `timed_out`, `abandoned` or `invalid_reply`. |
| `updatedAt` | string | The time of the last change, as an ISO 8601 UTC time. |
| `endedAt` | string or null | The time the request ended. `null` while it waits. |
| `endReason` | string or null | A short fixed phrase for how it ended, such as `client disconnected`, or the reason of an `invalid_reply`. `null` for `replied`. |

A request leaves `waiting` once and then never changes. The first thing that happens to it decides: a reply, a skip, the client leaving, the wait limit, a restart of `imbehind serve`, or an invalid reply file.

## reply.json

```json
{
  "formatVersion": 1,
  "kind": "text",
  "body": "Hello from my tool.",
  "source": "my-tool",
  "writtenAt": "2026-10-09T14:05:12.000Z"
}
```

| Field | Type | Meaning |
|---|---|---|
| `formatVersion` | number | Must be `1`. |
| `kind` | string | `text`, `json` or `skip`. |
| `body` | string | The reply. At least one character for `text` and `json`. An empty string for `skip`. |
| `source` | string, optional | Who wrote the file. `imbehind answer` writes `imbehind-answer`. It is not checked. |
| `writtenAt` | string, optional | When the file was written. It is not checked. |

- `text` and `json` both return `body` to the client as the content of the reply, exactly as written. Nothing is trimmed or changed.
- If the request has `replyKind` `json`, the `body` must be JSON text (RFC 8259: any top-level value, white space allowed around the tokens, and no comments, trailing commas, `NaN` or `Infinity`). This is checked for `text` and `json` alike, because it is the request that asks for JSON. If the request has `replyKind` `text`, the `body` is not checked, even for `kind` `json`.
- A reply that calls tools is a `body` that is a JSON array of calls, and it is written in the same file as any reply. See "Replies that call tools".
- `skip` ends the request without a reply. The client receives the error `skipped_by_human`, whatever the `replyKind` is.
- Unknown fields are ignored.
- The size limit is 10485760 bytes for the whole file. A file over the limit is refused without being read.
- The file must be UTF-8. One byte order mark at the start is allowed.

## Replies that call tools

There is no new `kind`. The `body` of a `text` or `json` reply is read as tool calls only when the request has `toolDefinitions` other than `none`, and the `body` is a JSON array that is not empty and whose every element is an object with a `function` key. Any other `body` is text, so a near miss (an array with one element that has no `function` key) is returned to the client as text.

```json
{
  "formatVersion": 1,
  "kind": "text",
  "body": "[{\"id\": \"call_1\", \"type\": \"function\", \"function\": {\"name\": \"get_weather\", \"arguments\": \"{\\\"city\\\": \\\"Tokyo\\\"}\"}}]"
}
```

Each call needs a non-empty string `id` that no earlier call of the reply uses, the `type` `function`, and a `function` with a non-empty string `name` and a string `arguments`. Other fields are allowed. `arguments` is not checked to be JSON. If `toolDefinitions` is `functions`, the array must have exactly one call. The checks apply to `text` and `json` replies alike, and a `skip` reply has no body to check.

For a request with `replyKind` `json`, a reply that calls tools passes check 7 (it is JSON) and is then judged by check 8.

## Writing a reply file

`imbehind serve` reads `reply.json` as soon as the name exists, so the file must be whole when it gets its name. A half-written `reply.json` is read as it is, and it ends the request as invalid. Write the file like this:

1. Write the whole content to a file in the same folder, with a name that starts with a dot, for example `.my-reply.tmp`. Check the size and the content before the next step.
2. Give it the final name with a hard link: make `reply.json` a link to `.my-reply.tmp`. A hard link fails if `reply.json` already exists, so of two writers only one succeeds, and nobody replaces a reply that is already there.
3. Remove the temporary name.

Do not use a plain rename (`mv`, `rename`): it replaces `reply.json` if it exists, and it hides the fact that someone else replied first.

```sh
ln .my-reply.tmp reply.json && rm .my-reply.tmp      # Linux and macOS
```

```js
// Node.js
await fs.writeFile(tmp, content);
await fs.link(tmp, replyFile); // throws EEXIST if reply.json already exists
await fs.unlink(tmp);
```

On Windows, `New-Item -ItemType HardLink -Path reply.json -Target .my-reply.tmp` does the same on an NTFS disk. The storage directory must support hard links.

If the link fails because `reply.json` exists, another reply came first. Your reply is not used.

## What `imbehind serve` checks

When a waiting request has a `reply.json` and no `reply.accepted.json`, `imbehind serve` reads the file once and checks it in this order. The first check that fails decides, and the reason is one of these fixed phrases. A phrase never contains a character of the file.

| # | The file is refused when | Reason |
|---|---|---|
| 1 | It is larger than 10485760 bytes. | `reply file is larger than 10 MB` |
| 2 | It is not JSON, or not valid UTF-8. | `reply file is not valid JSON` |
| 3 | The top level is not an object, or `formatVersion`, `kind` or `body` is missing, or `kind` or `body` is not a string. | `reply file is missing a required field` |
| 4 | `formatVersion` is not `1`. | `reply file has an unknown format version` |
| 5 | `kind` is not `text`, `json` or `skip`. | `reply file has an unknown kind` |
| 6 | `body` is empty for `text` or `json`, or not empty for `skip`. | `reply file has a body that does not fit its kind` |
| 7 | The request asks for JSON, `kind` is not `skip`, and `body` is not JSON text. | `reply body is not valid JSON (<detail>)` |
| 8 | `kind` is not `skip`, and `body` calls tools (see "Replies that call tools") but the calls do not fit. | `reply tool calls are not valid (<detail>)` |

The `<detail>` of check 7 is one of `unexpected end of input at line <n>`, `unexpected character at line <n>, column <m>` or `extra data after the JSON value at line <n>, column <m>`. It tells where reading stopped and never repeats the text.

The `<detail>` of check 8 is one of `call <n> needs a non-empty string id`, `call <n> has the same id as an earlier call`, `call <n> needs the type "function"`, `call <n> needs function.name as a non-empty string`, `call <n> needs function.arguments as a string`, or `this request defines functions only, so exactly one call is allowed`. `<n>` counts the calls from 1, and the first call that does not fit decides. It never repeats the text either.

A file that passes all eight checks is accepted. The exact bytes that were checked are kept as `reply.accepted.json`. If a tool changes `reply.json` after the check, the change is not used.

## When the reply file is not valid

- The state of the request becomes `invalid_reply` and `endReason` holds the reason.
- `reply.json` is left in place, so you can see what was wrong with your own tools. It is deleted with the folder after the retention time. No `reply.accepted.json` is made, and no other reply can be put there.
- The client receives HTTP 502 with `type` `server_error`, `code` `invalid_reply` and the message `The reply file was invalid: <reason>.`, also when it asked for a stream.
- `imbehind serve` prints one line, `<time> invalid_reply  <short id>  <reason>`, for example `14:41:30 invalid_reply  f1e2d3  reply file is not valid JSON`, whether or not a client waits for the request.

A `reply.json` that `imbehind serve` cannot read at all (no permission, it is a folder, an input or output failure) is not an invalid reply. `imbehind serve` prints an error line with the reason `unreadable` once, leaves the request waiting, and tries again at the next poll, 500 milliseconds later.

## Only the first reply is used

- If `reply.accepted.json` exists, it decides the request, and `reply.json` is not read.
- `imbehind answer` and your tools use the same rule. Of two replies, the one that arrived first is used. An `imbehind answer` whose reply came second prints `Not sent: this request was already answered in another window.`
- After an invalid `reply.json`, no reply can be put for the request: `reply.json` is still there.
- A request that was waiting when `imbehind serve` started is ended as `abandoned` before anything is read, so a `reply.json` that was left for it is ignored.
