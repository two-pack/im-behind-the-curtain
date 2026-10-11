# im-behind-the-curtain

An API server where a human writes the replies instead of an LLM. When the server receives a request, it writes it to a file. When the human writes a reply, the server returns it as the response.

[Japanese](README.ja.md)

## CLI

```
imbehind serve    # start the API at http://127.0.0.1:3000
imbehind answer   # read requests and type replies
imbehind path     # print where the files are stored
```

## Usage

You need Node.js 22 or later. In a clone of this repository, build the program once, then start the two commands in two terminals:

```sh
npm ci
npm run build
node dist/bin.js serve    # terminal 1: the API at http://127.0.0.1:3000
node dist/bin.js answer   # terminal 2: show requests and type replies
```

The rest of this README writes these as `imbehind serve` and `imbehind answer`.

1. Start `imbehind serve`. It prints one line with the address and the storage directory, and then one line for each request it receives and each reply it returns. It never prints what a request or a reply says.
2. Start `imbehind answer`. It prints `Waiting for requests...` until a request arrives.
3. Send a request, for example with the `curl` command shown under Example. The request is held open.
4. `imbehind answer` shows the request: when it arrived, the model name, and the conversation with a role name (`System`, `Developer`, `User`, `Assistant`) above each message.
5. Type your reply, and finish it with Ctrl+D (on Windows: Ctrl+Z, then Enter). Line breaks are normalized to `\n`, and the line breaks at the end are removed. An empty reply is not sent.
6. `curl` receives a Chat Completions response with your text in `choices[0].message.content`, and `imbehind answer` prints `Sent.`.

Press Ctrl+C to quit either command. When you quit `imbehind serve`, a request that nobody has answered stays in the storage directory as it is, and the next `imbehind serve` ends it as `abandoned` (see Storage). `imbehind answer` only starts while a `imbehind serve` runs.

### Structured output

If the request has `response_format` with `type` set to `json_schema` or `json_object`, `imbehind answer` shows `Reply:    JSON`. For `json_schema` it also shows the requested shape under `Required shape:`; for `json_object` it says that any JSON value is accepted. Type the JSON and finish with Ctrl+D (on Windows: Ctrl+Z, then Enter).

- The reply must be valid JSON (RFC 8259): any top-level value, with white space allowed, and no comments, trailing commas, `NaN` or `Infinity`. If it is not, nothing is sent. `imbehind answer` prints `Not sent: your reply is not valid JSON (...)` with the line (and column) where reading stopped, and asks again for the same request.
- The reply is not checked against the requested shape. A valid JSON reply that does not match it is sent as it is.
- The reply is sent exactly as you typed it, in `choices[0].message.content`.

### Streaming

If the request has `"stream": true`, nothing is sent while you write the reply. When you finish, the server sends the whole reply as `text/event-stream`: a chunk with the role, one chunk with your whole reply, a `stop` chunk, and `data: [DONE]`. With `"stream_options": {"include_usage": true}` it adds a last chunk with an empty `choices` and zero token counts before `[DONE]`. A request without `"stream": true` gets the normal JSON response, and structured output can be streamed the same way.

If the request cannot be stored, the server answers with the normal JSON error instead of starting a stream. The `received` line of `imbehind serve` shows `json` for structured output and `stream` for a streamed request, for example `chat/completions  json  stream`.

### Request content

A message `content` can be a string, `null` (shown as `(empty)`), or an array of text parts (`{"type": "text", "text": "..."}`, joined without a separator). A role other than `system`, `developer`, `user` or `assistant`, a malformed part, and an `n` of 2 or more are refused with a `400` error. Requests that ask for something a human cannot read or do are refused with a `400` error whose `code` is `unsupported_content`: a part that is not text (an image, audio, a file), `tools` or `functions` with at least one entry, a message with the role `tool` or `function`, and an `assistant` message with `tool_calls` or `function_call`. Empty `tools` and `functions` are accepted. Unknown fields are ignored. A request body larger than 10 MB (10485760 bytes) is refused with `413` and `request_too_large`, and nothing is stored.

`imbehind answer` shows every `system` and `developer` message and the last three of the other messages. When it leaves messages out, it prints one line such as `(3 earlier messages omitted. Full conversation: <path>)`, where `<path>` is the `request.json` file with the whole conversation. A message longer than 200 lines is cut after 200 lines with a similar line. Control characters other than newline and tab are shown as `\xNN` (for example `\x1b`).

Requests are stored in the storage directory (see Storage). The storage directory must support hard links.

`imbehind serve` accepts text messages on `POST /v1/chat/completions`, and answers `GET /v1/models` (see Model list). A request with a browser `Origin` header, or with a `Host` header that is not a local name, is refused. The local names are an address of `127.0.0.0/8` (such as `127.0.0.1`), `[::1]` and `localhost`, in any case and with or without a port.

### Skipping a request

If you end the input without typing anything (for example Ctrl+D right away), `imbehind answer` asks `Skip this request? The client will receive an error. [y/N]`. Only `y` or `Y` skips the request. The client receives a `503` error with the code `skipped_by_human`, `imbehind answer` prints `Skipped.`, and `imbehind serve` prints a `skipped` line. Any other answer, including Enter alone, takes you back to typing the reply. If the input ends at this question, nothing is sent: `imbehind answer` prints `Error: input ended. Nothing was sent; the request is still waiting.` and exits with code 1.

### Several requests

Several clients can wait at the same time. `imbehind answer` shows one request at a time, the oldest first, and counts again each time, for example `--- Request 1 of 3 (...)`. If a new request arrives while you type, it prints `New request received. 2 requests are waiting.` (the count includes the request you are answering), and what you typed is not lost.

You can run `imbehind answer` in two terminals. When both send a reply to the same request, only the first one is used, and the other prints `Not sent: this request was already answered in another window.`

### When the client leaves, and the wait limit

If the client closes the connection before you reply, the request ends as `cancelled`. `imbehind answer` tells you at once, even while you type (`Cancelled: the client disconnected. Your reply will not be sent.`), drops what you typed and moves on to the next request. `imbehind serve` prints `cancelled  <id>  client disconnected`.

`imbehind serve` waits for a reply for 1800 seconds (30 minutes) by default. Change it with `--timeout <seconds>` or the environment variable `IMBEHIND_TIMEOUT`; the option wins over the variable, and an empty variable counts as not set. The value is a whole number of seconds from 0 to 2147483, and `0` means no limit. Only `imbehind serve` takes it.

```sh
imbehind serve --timeout 600
IMBEHIND_TIMEOUT=600 imbehind serve
```

When the limit passes, the client receives a `504` error with the code `reply_timeout` and the message `No reply within <limit> seconds. Increase the server timeout or reply sooner.`, `imbehind serve` prints a `timed_out` line, and `imbehind answer` shows `Timed out: the request waited longer than <limit> seconds. Your reply will not be sent.` if you were answering it. A value that is not allowed stops the start with a line such as `Error: --timeout must be a whole number of seconds from 0 to 2147483 (got "abc").` and exit code 2.

### Client wait time and retries

The server waits as long as its own limit, but a client may give up earlier. Set the timeout of your client to at least the wait limit of `imbehind serve`, and turn its automatic retries off. The official OpenAI SDKs for Python and Node wait 600 seconds by default and send a request again, up to 2 times, after a `408`, `409`, `429` or `5xx` answer and after a failed connection. With the defaults, a request that you skip (`503`) or that times out (`504`) is sent again and shows up as a new request, and a request that waits longer than 600 seconds is dropped by the SDK, ends as `cancelled`, and is also sent again. The settings below keep one request for 30 minutes and send it only once:

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

## Settings

`imbehind serve` has six settings. Each one comes from the command line option if you give it, else from the environment variable, else from the default. An empty environment variable counts as not set. Write an option as `--port 3100` or `--port=3100`.

| Option | Environment variable | Default | Meaning |
|---|---|---|---|
| `--host` | `IMBEHIND_HOST` | `127.0.0.1` | The address to listen on. Only a local address is allowed: an address of `127.0.0.0/8`, `::1` (also written `[::1]`), or `localhost` when every address it names is local. |
| `--port` | `IMBEHIND_PORT` | `3000` | The port, from 1 to 65535. |
| `--dir` | `IMBEHIND_DIR` | the storage directory of your system (see Storage) | The storage directory. A relative path is made absolute from the folder where you start the command. |
| `--timeout` | `IMBEHIND_TIMEOUT` | `1800` | How long to wait for a reply, in seconds, from 0 to 2147483. `0` means no limit. |
| `--retention` | `IMBEHIND_RETENTION` | `86400` | How long a finished request is kept, in seconds, from 0 to 315360000. `0` means never delete. |
| `--sweep-interval` | `IMBEHIND_SWEEP_INTERVAL` | `600` | How often old requests are looked for, in seconds, from 1 to 2147483. |

`imbehind answer` and `imbehind path` take only `--dir` and `IMBEHIND_DIR`, and they find the same storage directory as `imbehind serve`. If you give `--port` or another option of `imbehind serve` to them, they stop with the usage line.

`--retention` must not be shorter than `--timeout` when neither is 0, because a request could be deleted while it still waits. Every value is checked before anything is created or opened, in this order: the way the command is written, `--host`, `--port`, `--timeout`, `--retention`, `--sweep-interval`, `--dir`, then retention against timeout. The first problem is printed as one line and nothing else happens:

```
Error: 0.0.0.0 is not a local address. imbehind only listens on this machine (127.0.0.0/8, ::1, localhost).
Error: --port must be a number from 1 to 65535 (got "abc").
Error: --retention (600 seconds) must not be shorter than --timeout (1800 seconds).
```

The exit codes are 0 for success (`imbehind path`), 1 when a command cannot start or cannot read the storage directory (a port that is in use, an address that is not available, a storage directory that is used by another `imbehind serve`, `imbehind serve` not running for `imbehind answer`), 2 for a wrong way of writing the command or a value that is not allowed, and 130 for Ctrl+C.

## Storage

The default storage directory is `$XDG_DATA_HOME/imbehind` (or `~/.local/share/imbehind` when `XDG_DATA_HOME` is not set) on Linux, `~/Library/Application Support/imbehind` on macOS, and `%LOCALAPPDATA%\imbehind` on Windows. `imbehind path` prints the storage directory that the current options and variables choose, as one line, and exits with code 0. It does not create or read anything, so it works before the first start.

```sh
imbehind path
IMBEHIND_DIR=/data/imbehind imbehind path
```

Only `imbehind serve` creates the storage directory. `imbehind answer` never creates it.

- **Permissions.** On Linux and macOS, `imbehind serve` creates every folder with mode `0700` and every file with mode `0600`, so only you can use them. A folder that exists already is not changed, and a `reply.json` that you put there yourself keeps its mode (the `reply.accepted.json` that is made from it is always `0600`). On Windows no mode is set, and the permissions of your user profile apply.
- **One serve for one directory.** `imbehind serve` writes `serve.lock` in the storage directory and renews it every 5 seconds. A second `imbehind serve` on the same directory stops with `Error: <directory> is already used by another imbehind serve.` A lock that was left by a `imbehind serve` that was killed is taken over by itself, as soon as its process is gone or its last renewal is more than 15 seconds old. A `serve.lock` that is not a lock file of this program is never read or deleted: `imbehind serve` stops and tells you to remove it if no `imbehind serve` uses the directory.
- **Restart.** The requests that were still waiting when `imbehind serve` started (for example because the earlier one was stopped with Ctrl+C) are ended as `abandoned` right after the first line, one line each, such as `14:00:00 abandoned  c9d0e1  server restarted`. Their clients are gone, so they are not shown by `imbehind answer`.
- **Old requests.** A finished request is deleted with its folder once `--retention` seconds have passed since it ended (24 hours by default). The check runs at the start and then every `--sweep-interval` seconds (10 minutes by default). A request that waits is never deleted. A folder is deleted only when it holds nothing but `request.json`, `state.json`, `reply.json`, `reply.accepted.json` and the hidden files named like `.reply.accepted.<pid>.<seq>.<hex>.tmp` (also `.state.…` and `.reply.…`) that a stopped `imbehind serve` can leave behind. If it holds any other file, it is kept as it is and `imbehind serve` prints a line such as `14:05:12 error      a1b2c3  kept unknown files` once for that request. With `--retention 0` nothing is deleted. Apart from those leftovers, files and folders whose names start with a dot, and files that this program did not make, are never read or deleted. A symbolic link in `requests/` is neither followed nor deleted.
- **Without a serve.** When no `imbehind serve` runs, `imbehind answer` ends with exit code 1 and prints `Error: imbehind serve is not running for <directory>.` and `Start it with: imbehind serve`. If it cannot read the directory, it prints `Error: cannot read <directory>: <reason>.` It checks once, when it starts.

### Model list

`GET /v1/models` returns the same list every time, with no API key needed and without storing anything or printing a line:

```json
{
  "object": "list",
  "data": [{ "id": "imbehind", "object": "model", "created": 1791800000, "owned_by": "imbehind" }]
}
```

Any other method on this path is refused with `405`.

## Development

```sh
npm ci
npm run check    # type check, lint and format check, tests with coverage, knip, dependency rules (works offline)
npm test         # tests only, with the 80% line and branch coverage thresholds
npm run audit    # npm audit (needs the network)
```

Installing the dependencies does not touch your git hooks. If you want `npm run check` to run before each commit, install the hook yourself. This is optional:

```sh
npm run hooks:install    # sets core.hooksPath to .githooks for this clone
```

Setting `core.hooksPath` stops the hooks under `.git/hooks/` from running in this clone. If you already use hooks there, move them to `.githooks/` or skip this step.

## Endpoints

| Use with | Endpoint |
|---|---|
| Other OpenAI-compatible clients | `POST /v1/chat/completions` |
| Model list | `GET /v1/models` |

Any model name and API key will do.

### Example

```sh
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"whatever","messages":[{"role":"user","content":"Hello"}]}'
```

## Notes

- Everything you send is saved to files and read by a human. A request that is refused, such as one with an image, is not saved.
- There is no authentication. Use it only on your own machine.
- Not affiliated with OpenAI, Anthropic, or any other company named here.

## License

MIT
