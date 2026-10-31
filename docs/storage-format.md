# Storage format

`imbehind serve` keeps every request as a small folder of JSON files. The files are the only state: nothing is hidden in memory that a restart would lose. Any tool can read them, and a tool can also write a reply, instead of using `imbehind answer`. This document is the contract for that. It describes format version 3 of `request.json` and format version 1 of the other files.

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
      message-<m>-part-<p>.<extension>
```

- `serve.lock` belongs to `imbehind serve`. Do not read or write it.
- A request id looks like `20261009T140512123Z-a1b2c3`: the time the request arrived (UTC), a dash, and six hex digits. The log lines and the screens of `imbehind answer` show only the last six digits, the short id. Ids sort in the order the requests arrived.
- `request.json` and `state.json` are written by `imbehind serve`. A tool may read them and must never write them.
- `reply.json` is where a reply is put, by `imbehind answer` or by a tool (see "Writing a reply file"). When `imbehind serve` accepts it, the content is kept as `reply.accepted.json` and `reply.json` is removed. A request that was ended by an invalid reply keeps its `reply.json` (see "When the reply file is not valid").
- `message-<m>-part-<p>.<extension>` is a part of a message that is not text (an image, audio or a file), saved as a file. A request has none, one or many of them. They are written by `imbehind serve`, next to `request.json`. See "Saved files".
- Files and folders whose names start with a dot are temporary or belong to other programs. Leave them alone. Finished requests are deleted with their folder after the retention time (see the README).

## Format version

Every file has the field `formatVersion`, a whole number. The `formatVersion` of `request.json` is `3`. The `formatVersion` of `state.json` and `reply.json` stay at `1`. A reader must treat a file with a `formatVersion` it does not know as a file it does not understand. `imbehind serve` does so for `reply.json` (reason `reply file has an unknown format version`).

- This version reads versions 1, 2 and 3 for `request.json`. A request file of version 1, written by an older version, has no `toolDefinitions` field, and it is read as if `toolDefinitions` were `none`. A file of version 1 or 2 has no `attachments`; the key is not looked at in such a file, and every message is read as one without parts that are not text.
- This version writes version 3 for every request, not only for requests that have parts that are not text. A file of version 1 or 2 that is already in the storage directory is not rewritten.
- An older version of `imbehind` that knows only versions 1 and 2 treats a version 3 `request.json` as a file it cannot read: its `imbehind answer` does not list these requests, and its `imbehind serve` reports them as unreadable. An older version that knows only version 1 does the same for version 2 and 3. Any tool of yours that reads `request.json` must accept `3` as well as `1` and `2`.
- A version 2 or 3 file whose `toolDefinitions` is missing or is not one of the four values below is not readable. A version 3 file whose `attachments` break the rules in "Attachments" is not readable either.

## request.json

| Field | Type | Meaning |
|---|---|---|
| `formatVersion` | number | `3`. A file written by an older version has `1` or `2`. |
| `id` | string | The request id. |
| `receivedAt` | string | When the request arrived, as an ISO 8601 UTC time. |
| `format` | string | The API format of the request. `chat.completions`. |
| `model` | string | The `model` the client sent. |
| `replyKind` | string | What the human has to write: `text`, or `json` when the client asked for structured output. |
| `requiredShape` | object or null | The JSON Schema the client asked for, or `null`. It is shown to the human and is not checked. |
| `stream` | boolean | The client asked for a stream. |
| `includeUsage` | boolean | The client asked for the usage chunk of a stream. |
| `toolDefinitions` | string | Which definitions the request carries: `tools`, `functions`, `both` or `none`. An empty array counts as no definition. It decides how a reply is told from tool calls. |
| `conversation` | array | The messages, each `{ "role": "system" \| "developer" \| "user" \| "assistant" \| "tool" \| "function", "content": string }`, the `attachments` below when the message has parts that are not text, and, only when the client sent them, the tool fields below. `content` is the text parts joined without a separator, and it is an empty string when there is no text part. |
| `originalRequest` | object | The body the client sent, as it arrived, `tools` and `functions` included. |

### Tool fields of a message

A message in `conversation` can also have `tool_call_id`, `name`, `tool_calls` and `function_call`. A field is there only when the client sent it, and its value is stored exactly as received, with whatever type the client used. Nothing is checked or changed, so a form that is wrong (a `tool_calls` that is not an array, a `function_call` that is a string) is stored too, and `imbehind answer` shows it as `(unreadable tool call)`. A `content` that was `null` or missing is stored as an empty string. A message that the client sent without these fields has only `role` and `content`.

### Attachments

The `content` of a message that the client sent can be an array of parts. The text parts are joined without a separator and stored as `content`. A message with no text part has `content` set to an empty string. Every other part (an `image_url`, an `input_audio` or a `file` part, or a part of any other `type`) becomes one item of `attachments`, in the order the parts arrived. A message that has no such part has no `attachments` key. When the key is there, it has at least one item: an empty array cannot be read, and the whole `request.json` is then unreadable. `originalRequest` still holds the body exactly as received, data and all.

An item has these fields. All nine are always present.

| Field | Type | Meaning |
|---|---|---|
| `at` | number | How many Unicode characters of `content` come before the part: `0` or more, at most the number of characters of `content`, and never smaller than the `at` of the item before. A character outside the Basic Multilingual Plane counts as one. |
| `kind` | string | `image`, `audio`, `file` or `other`. `other` is a part with a `type` that this version does not know. |
| `mediaType` | string or null | The media type of the saved data, in lower case, or `null` when it is not known. |
| `size` | number or null | The number of bytes of the saved file, after decoding. `null` when nothing is saved. |
| `file` | string or null | The name of the saved file (see "Saved files"). `null` when nothing is saved. |
| `readable` | boolean | `false` when the part has a known `type` but its content does not have a form that can be read. |
| `address` | string or null | The address of an image, as received. It is never fetched. |
| `fileId` | string or null | The `file_id` of a file, as received. It is never fetched. |
| `typeName` | string or null | The `type` of a part of kind `other`, as received. |

Each item must fit one row of this table. A cell with `-` is `null`.

| State | `kind` | `readable` | `mediaType` | `size` | `file` | `address` | `fileId` | `typeName` |
|---|---|---|---|---|---|---|---|---|
| saved | `image`, `audio`, `file` | `true` | string or `-` | number (`0` too) | string | - | - | - |
| address only | `image` | `true` | - | - | - | string | - | - |
| file id only | `file` | `true` | - | - | - | - | string | - |
| no data | `file` | `true` | - | - | - | - | - | - |
| unreadable | `image`, `audio`, `file` | `false` | - | - | - | - | - | - |
| unknown type | `other` | `true` | - | - | - | - | - | string |

- A part is saved when its data can be read: a `data:` URL with `;base64` and base64 text (an `image_url` or a `file_data`), or the base64 text `data` of an `input_audio`. Empty data is saved as a file of `0` bytes. An address that does not start with `data:` is kept as `address` and not saved. A `file` part with a `file_id` and no `file_data` is kept as `fileId` and not saved.
- A part that has a known `type` but cannot be read is accepted and stored as unreadable. It is not saved, and nothing of it is kept in the item.
- `mediaType` is the first item of the header of the `data:` URL, in lower case, when it has the form `type/subtype`. Otherwise it is `null`. For an `input_audio`, the `format` `wav` gives `audio/wav` and `mp3` gives `audio/mpeg`; any other `format` gives `null`, and the data is still saved.
- An item that does not fit any row of this table, or whose `at` breaks the rule above, means that the whole `request.json` cannot be read. Unknown keys are ignored.

### Saved files

The data of a saved part is written to a file in the request folder, `requests/<request id>/`, next to `request.json`.

- The name is `message-<m>-part-<p>.<extension>`. `<m>` is the number of the message in `messages`, and `<p>` is the number of the part in the `content` array, text parts included. Both numbers count from 1. The same input always gets the same names, and two parts with the same data are saved as two files.
- The extension comes from the media type, by this table. Any other media type, and an unknown one, gets `.bin`.

  | Media type | Extension |
  |---|---|
  | `image/png` | `png` |
  | `image/jpeg` | `jpg` |
  | `image/gif` | `gif` |
  | `image/webp` | `webp` |
  | `image/bmp` | `bmp` |
  | `image/svg+xml` | `svg` |
  | `audio/wav` | `wav` |
  | `audio/mpeg` | `mp3` |
  | `application/pdf` | `pdf` |

- Nothing the client sent is used in a name or in a path: not a `filename`, not an address, not a `format` and not a `type`. A reader checks the form of `file`, not the table: `message-`, a whole number of 1 or more, `-part-`, a whole number of 1 or more, a dot, and an extension of lower case letters and digits.
- All the saved files are written before `request.json` becomes visible, in the same hidden folder, so it is all or nothing. If a write fails, the request is not stored, no file stays, and the client gets the error `storage_error`. If `imbehind serve` stops in the middle, a hidden folder is left behind. It is never shown as a request and never read, and the next start works without cleanup.
- On Linux and macOS the files have the mode `0600`. A tool may read them and must never write them.
- A saved file is deleted with the request folder, once the retention time has passed after the request finished. Only the names recorded in `attachments` are deleted, and only when they have the form above. A folder that holds any other file, a directory or a symbolic link is kept and is not deleted; see the specification for the `error` line.
- To know which files are its own, the deletion reads `request.json`. A `request.json` that is larger than 278746355 bytes (`MAX_REQUEST_FILE_BYTES` in the code) is not read. It can be larger than the body of the request, because it holds the body once as received and again as parsed text, and because it is written with an indent. So the saved files of such a request are not known. The folder is kept only if it also holds a file that has the form of a saved name (`message-<m>-part-<p>.<extension>`); otherwise it is removed as usual. The same holds for a `request.json` that cannot be read.

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
