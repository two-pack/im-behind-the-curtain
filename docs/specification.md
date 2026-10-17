# Specification

This document describes how `imbehind` behaves. The requirements that it meets are in [requirements.md](requirements.md). The files that the server writes are in [storage-format.md](storage-format.md). Where this document and the code disagree, the code is right and this document has a mistake that should be reported.

## Overview

`imbehind` has three commands.

| Command | What it does |
|---|---|
| `imbehind serve` | Starts the API server on a local address. It stores each request and holds the connection until a reply arrives. |
| `imbehind answer` | Shows waiting requests and sends the reply that a human types. |
| `imbehind path` | Prints the storage directory. It creates and reads nothing. |

The server and `imbehind answer` meet only through files in the storage directory. `imbehind answer` starts only while a `imbehind serve` runs for the same storage directory.

## HTTP interface

The server listens on `127.0.0.1:3000` by default. It has two routes.

| Route | Purpose |
|---|---|
| `POST /v1/chat/completions` | Send a request and wait for a human reply |
| `GET /v1/models` | List the models (the same answer every time, no API key needed) |

Any other path gets `404`. Another method on a known path gets `405` with an `Allow` header. A request with a browser `Origin` header, or with a `Host` header that is not a local name, gets `400`. The local names are an address in `127.0.0.0/8`, `[::1]` and `localhost`, in any case, with or without a port.

### Request

`POST /v1/chat/completions` takes a JSON body with `model` (a string, any value) and `messages` (a non-empty array). An API key is not needed, and one is not checked. Fields that the server does not know are ignored.

- `role` must be `system`, `developer`, `user`, `assistant`, `tool` or `function`.
- `content` can be a string, `null` (shown as `(empty)`) or an array of text parts `{"type": "text", "text": "..."}`, which are joined without a separator. An `assistant` message that has `tool_calls` or `function_call` may leave `content` out.
- `tools`, `functions`, `tool_calls`, `function_call` and the messages of the roles `tool` and `function` are accepted. See "Tool calls".
- `n` must be missing or 1.
- `response_format.type` set to `json_schema` or `json_object` asks for a JSON reply. Any other request asks for text.
- `stream: true` asks for a streamed response. `stream_options.include_usage: true` adds a usage chunk.
- A body larger than 10 MB (10485760 bytes) is refused. A body of exactly 10485760 bytes is accepted.

### Requests that are refused

A refused request is not stored and not shown to a human. The error has the OpenAI shape:

```json
{ "error": { "message": "...", "type": "invalid_request_error", "code": "unsupported_content" } }
```

`type` is `invalid_request_error` for a mistake of the client and `server_error` for the codes `storage_error`, `skipped_by_human`, `reply_timeout` and `invalid_reply`.

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | The body is not JSON; `model` or `messages` is missing or wrong; a message is not an object; a `content` has a wrong type or a part has a wrong form; the role is not one of the six; `n` is 2 or more; the `Origin` or `Host` header is not allowed |
| 400 | `unsupported_content` | A part that is not text (an image, audio, a file) |
| 404 | `not_found` | The path is not known |
| 405 | `method_not_allowed` | The method is not allowed on this path |
| 413 | `request_too_large` | The body is larger than 10 MB. The connection is closed after the answer |
| 500 | `storage_error` | The request could not be stored |
| 502 | `invalid_reply` | A reply file written by a user was not valid (see [storage-format.md](storage-format.md)) |
| 503 | `skipped_by_human` | The human skipped the request |
| 504 | `reply_timeout` | No reply came within the wait limit |

### Response

When the human reply arrives, the server answers `200` with:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1791800000,
  "model": "<the model of the request>",
  "choices": [
    { "index": 0, "message": { "role": "assistant", "content": "<the reply>" }, "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 }
}
```

The token counts are always 0, because a human reply has no token count.

### Streaming

Nothing is sent while the human writes. When the reply is complete, the server sends `Content-Type: text/event-stream` with these chunks, each as `data: <JSON>` and an empty line:

1. A chunk with the delta `{"role": "assistant", "content": ""}`
2. A chunk with the delta `{"content": "<the whole reply>"}`
3. A chunk with the delta `{}` and `finish_reason` `stop`
4. With `stream_options.include_usage` true: a chunk with an empty `choices` array and a `usage` of zeros
5. `data: [DONE]`

All chunks share the same `id` and `created`. The `object` is `chat.completion.chunk`. If the request fails before the reply (skipped, timed out, not stored), the server returns a normal JSON error and starts no stream.

### Structured output

For `json_schema` and `json_object`, `imbehind answer` shows `Reply:    JSON`. For `json_schema` it shows the requested shape. The reply must be valid JSON (RFC 8259). It is not checked against the shape. It is returned as typed, in `choices[0].message.content`, and it can be streamed like any other reply.

### Tool calls

A request may have `tools` or `functions`, messages with the role `tool` or `function`, and `assistant` messages with `tool_calls` or `function_call`. All of these are accepted and stored. Empty `tools` and `functions` arrays are accepted and count as no definition. The entries of `tools` and `functions` are not checked, and `tool_choice` and `parallel_tool_calls` are ignored. `originalRequest` in the stored request keeps the body unchanged. The messages are stored as received, with `tool_call_id`, `name`, `tool_calls` and `function_call`, even when their form is wrong; see [storage-format.md](storage-format.md).

**What the screen shows.** `imbehind answer` names the role of every message, `Tool:` and `Function:` included. For an `assistant` message it shows each call as `tool_call: <name>(<arguments>)` and the old form as `function_call: <name>(<arguments>)`. The arguments are cut to 80 characters of Unicode, with `...` at the end when they are cut. A message with no text and with calls shows the calls, not `(empty)`. A call that cannot be read (`tool_calls` that is not an array, an element that is not an object, a function without a string name) is shown as `(unreadable tool call)`. After the conversation, a line `Tools: <names>` and a line `Functions: <names>` list the names; an entry without a name is `(unnamed)`, and nothing is listed when both are empty. Control characters are shown as `\xNN`.

**How to reply with tool calls.** When the request has at least one definition in `tools` or `functions`, type a JSON array of calls instead of text:

```json
[{"id": "call_1", "type": "function", "function": {"name": "get_weather", "arguments": "{\"city\": \"Tokyo\"}"}}]
```

- The reply is taken as tool calls only when it is a JSON array that is not empty and whose every element is an object with a `function` key. Any other reply is sent as text. A near miss, such as one element without `function`, is therefore sent as text.
- Each call needs a non-empty string `id` that no earlier call of the reply uses, the `type` `function`, and a `function` with a non-empty string `name` and a string `arguments`. Other fields are allowed. `arguments` is not checked to be JSON.
- Calls that do not fit are not sent. The screen says which call and which field does not fit (for example `Not sent: your tool calls are not valid (call 2 needs function.arguments as a string).`), without any typed character, and asks again. From standard input the command sends nothing and exits with code 1. A reply file ends the request as `invalid_reply`.
- With `response_format` set to `json_schema` or `json_object`, tool calls are accepted too, and every other reply must be valid JSON.

**What the client receives.** For `tools` (alone or together with `functions`) and a request that is not streamed, `message.content` is `null`, `message.tool_calls` is the array as typed, and `finish_reason` is `tool_calls`:

```json
{ "role": "assistant", "content": null, "tool_calls": [ { "id": "call_1", "type": "function", "function": { "name": "get_weather", "arguments": "{\"city\": \"Tokyo\"}" } } ] }
```

For a streamed request the chunks are:

1. A chunk with the delta `{"role": "assistant", "content": null}`
2. One chunk for each call, with the delta `{"tool_calls": [{"index": <0, 1, ...>, "id": ..., "type": "function", "function": {"name": ..., "arguments": <the whole arguments>}}]}`
3. A chunk with the delta `{}` and `finish_reason` `tool_calls`
4. With `stream_options.include_usage` true: the usage chunk, as for text
5. `data: [DONE]`

In a stream, only `index`, `id`, `type`, `function.name` and `function.arguments` are sent. Other fields of a call are dropped, while a response that is not streamed passes them on.

When the request defines `functions` and no `tools`, the reply must have exactly one call. The response has `message.function_call` set to `{"name": ..., "arguments": ...}` (no `id` and no `type`), `content` `null` and `finish_reason` `function_call`. A stream has one chunk with the delta `{"function_call": {...}}` and a last chunk with `finish_reason` `function_call`. Several calls in the reply are not sent; the human types again.

A text reply to a request with tools is sent as text, as for any request.

### Model list

`GET /v1/models` returns one model:

```json
{
  "object": "list",
  "data": [{ "id": "imbehind", "object": "model", "created": 1791800000, "owned_by": "imbehind" }]
}
```

### Client wait time and retries

The server waits for a reply as long as its wait limit (30 minutes by default), but a client may give up earlier. Set the timeout of the client to at least the wait limit of `imbehind serve`, and turn its automatic retries off.

The official OpenAI SDKs for Python and Node wait 600 seconds by default. They send a request again, up to 2 times, after a `408`, `409`, `429` or `5xx` answer and after a failed connection. With the defaults:

- a request that a human skips (`503`) or that times out (`504`) is sent again and shows up as a new request;
- a request that waits longer than 600 seconds is dropped by the SDK, ends as `cancelled`, and is also sent again.

These settings keep one request for 30 minutes and send it only once:

```python
client = OpenAI(base_url="http://127.0.0.1:3000/v1", api_key="any", max_retries=0, timeout=1800)
```

```js
const client = new OpenAI({
  baseURL: "http://127.0.0.1:3000/v1",
  apiKey: "any",
  maxRetries: 0,
  timeout: 1800 * 1000,
});
```

If you change the wait limit of the server, change the timeout of the client to match.

## Commands

### Settings of `imbehind serve`

Each setting comes from the command line option if it is given, else from the environment variable, else from the default. An empty environment variable counts as not set. An option can be written `--port 3100` or `--port=3100`.

| Option | Environment variable | Default | Meaning |
|---|---|---|---|
| `--host` | `IMBEHIND_HOST` | `127.0.0.1` | The address to listen on. Only a local address is allowed: an address of `127.0.0.0/8`, `::1` (also `[::1]`), or `localhost` when every address it names is local. |
| `--port` | `IMBEHIND_PORT` | `3000` | The port, from 1 to 65535. |
| `--dir` | `IMBEHIND_DIR` | the data directory of the system | The storage directory. A relative path is made absolute from the folder where the command starts. |
| `--timeout` | `IMBEHIND_TIMEOUT` | `1800` | The wait limit in seconds, from 0 to 2147483. `0` means no limit. |
| `--retention` | `IMBEHIND_RETENTION` | `86400` | How long a finished request is kept, in seconds, from 0 to 315360000. `0` means never delete. |
| `--sweep-interval` | `IMBEHIND_SWEEP_INTERVAL` | `600` | How often old requests are looked for, in seconds, from 1 to 2147483. |

`imbehind answer` and `imbehind path` take only `--dir` and `IMBEHIND_DIR`, and they find the same storage directory as `imbehind serve`. Any other option makes them stop with the usage line.

`--retention` must not be shorter than `--timeout` when neither is 0. Every value is checked before anything is created or opened, in this order: the way the command is written, `--host`, `--port`, `--timeout`, `--retention`, `--sweep-interval`, `--dir`, then retention against timeout. The first problem is printed as one `Error:` line and nothing else happens.

### What `imbehind serve` prints

It prints `Listening on http://<host>:<port> (storage: <directory>)`, and then one line for each event: `received`, `replied`, `skipped`, `cancelled`, `timed_out`, `abandoned`, `invalid_reply` and errors. A line has the time, the kind of event, the short id (the last six characters of the request id) and, for some events, a reason. It never prints what a request or a reply says. The `received` line also says `json` for structured output and `stream` for a streamed request.

### What `imbehind answer` does

With a terminal as standard input, it shows one request at a time, oldest first, and reads the reply until the end of input (Ctrl+D; on Windows Ctrl+Z, then Enter). It then prints `Sent.` Line breaks become `\n` and the line breaks at the end are removed. An empty reply is not sent: the command asks `Skip this request? The client will receive an error. [y/N]`, and only `y` or `Y` skips.

It shows every `system` and `developer` message and the last three of the other messages. When it leaves messages out, it prints a line such as `(3 earlier messages omitted. Full conversation: <path>)`. A message longer than 200 lines is cut after 200 lines. Control characters other than newline and tab are shown as `\xNN`. What is shown for tools, tool calls and tool messages is described in "Tool calls".

If the request ends while the human types (the client left or the wait limit passed), or another window replied first, the command says so, drops what was typed and goes on to the next request. If a new request arrives, it prints the number of waiting requests.

#### Replying from standard input

When standard input is not a terminal (a pipe or a redirected file), the command does not show the conversation. It sends the whole input as the reply to the first waiting request, the one that arrived first, prints one line, and exits.

```sh
echo "Hi" | imbehind answer      # Sent reply to request a1b2c3.
imbehind answer < reply.txt
```

- The input must be UTF-8. One byte order mark at the start is removed. Line breaks are normalized, and the line breaks at the end are removed, as for a typed reply. An empty input is not sent. For a request that asks for JSON, the input must be valid JSON, as for a typed reply. Tool calls are told from text and checked by the same rules as a typed reply (see "Tool calls").
- A reply whose written file would be larger than 10 MB (10485760 bytes) is not sent. This also holds for a typed reply, where the command prints `Not sent: your reply is larger than 10 MB.` and asks again. Quotes and line breaks take more room in the file than in the text.
- When it works, it prints `Sent reply to request <id>.` and exits with code 0. When the reply cannot be sent, it prints one `Error:` line on standard error and exits with code 1, and the request keeps waiting. It also stops when the request ends meanwhile (the client left, the wait limit passed, or another window or a tool replied first), and it says so.
- If no request is waiting, it waits without printing anything until one arrives, also when the input is already closed or empty. Press Ctrl+C to quit (exit code 130).
- Skipping is not possible from standard input.

A tool can also write a `reply.json` file itself, without `imbehind answer`. A reply file that is not valid ends the request with the error `invalid_reply`. See [storage-format.md](storage-format.md) for the format, how to write the file safely, and the checks.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (`imbehind path`, or a reply sent from standard input) |
| 1 | A command cannot start or cannot read the storage directory (the port is in use, the address is not available, another `imbehind serve` uses the directory, `imbehind serve` is not running for `imbehind answer`), or a reply from standard input could not be sent |
| 2 | The command is written wrongly, or a value is not allowed |
| 130 | Ctrl+C |

## Storage and states

The storage directory is `$XDG_DATA_HOME/imbehind` (or `~/.local/share/imbehind`) on Linux, `~/Library/Application Support/imbehind` on macOS, and `%LOCALAPPDATA%\imbehind` on Windows. Only `imbehind serve` creates it.

Each request is a folder with `request.json`, `state.json`, and, once a reply exists, `reply.json` or `reply.accepted.json`. The format of these files is in [storage-format.md](storage-format.md). The state of a request is one of:

| State | Meaning |
|---|---|
| `waiting` | A human reply is awaited |
| `replied` | The reply was returned to the client |
| `skipped` | A human skipped the request |
| `cancelled` | The client closed the connection |
| `timed_out` | The wait limit was reached |
| `abandoned` | It was still waiting when the server stopped; the next start ended it |
| `invalid_reply` | A reply file written by a user was not valid |

Other rules:

- On Linux and macOS, folders are created with mode `0700` and files with mode `0600`.
- `imbehind serve` writes `serve.lock` in the storage directory and renews it every 5 seconds. A second `imbehind serve` for the same directory stops. A lock left by a killed server is taken over when its process is gone or its last renewal is more than 15 seconds old. A `serve.lock` that is not a lock of this program is never read or deleted.
- At start, requests that are still `waiting` are ended as `abandoned`.
- A finished request is deleted with its folder when `--retention` seconds have passed since it ended. The check runs at start and then every `--sweep-interval` seconds. A folder with files that this program did not make is kept, and one `error` line is printed for it. A waiting request is never deleted.
- The storage directory must support hard links.
- Only the first reply to a request is used, whether it comes from `imbehind answer`, from another window, or from a file written by a tool.

## Limits

| Limit | Value |
|---|---|
| Request body | 10485760 bytes |
| Reply (written file) | 10485760 bytes |
| Messages shown by `imbehind answer` | all `system` and `developer`, and the last 3 others |
| Lines of one message shown | 200 |
| Authentication | None. Use the server only on your own machine |
