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

Press Ctrl+C to quit either command. A request that nobody has answered stays in the storage directory, and `imbehind answer` shows it again the next time it starts.

Requests are stored under the user data directory: `$XDG_DATA_HOME/imbehind` (or `~/.local/share/imbehind`) on Linux, `~/Library/Application Support/imbehind` on macOS, and `%LOCALAPPDATA%\imbehind` on Windows. The storage directory must support hard links.

In this version `imbehind serve` always listens on `127.0.0.1:3000`, and it accepts text messages on `POST /v1/chat/completions`. A request with a browser `Origin` header, or with a `Host` header that is not `127.0.0.1` or `localhost`, is refused.

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

- Everything you send, including images, is saved to files and read by a human.
- There is no authentication. Use it only on your own machine.
- Not affiliated with OpenAI, Anthropic, or any other company named here.

## License

MIT
