# im-behind-the-curtain

An API server where a human writes the replies instead of an LLM. When the server receives a request, it writes it to a file. When the human writes a reply, the server returns it as the response. Use it to see how an LLM client behaves without a real model, or to play the part of the AI yourself.

[Japanese](README.ja.md)

## Install

You need Node.js 24 or later.

```sh
npm install --global imbehind
```

## Use

Start the server in one terminal and the reply screen in another:

```sh
imbehind serve    # the API at http://127.0.0.1:3000
imbehind answer   # show requests and type replies
```

Send a request from a third terminal:

```sh
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"whatever","messages":[{"role":"user","content":"Hello"}]}'
```

`imbehind answer` shows the request. Type a reply and end it with Ctrl+D (on Windows: Ctrl+Z, then Enter). `curl` then prints a Chat Completions response with your text in it. `imbehind path` prints the directory where the files are stored.

## What it supports

- `POST /v1/chat/completions` in the Chat Completions format: text messages, JSON replies for structured output, and streaming. Any model name and any API key will do.
- `GET /v1/models`.
- A part that is not text (image, audio, a file) and tool-related requests (`tools`, `functions`, `tool_calls`) are refused with a `400` error whose `code` is `unsupported_content`. They are not saved.

The server waits for a reply for 30 minutes by default. Set the timeout of your client to at least that, and turn its automatic retries off, or the client may give up and send the request again. [The specification](https://github.com/two-pack/im-behind-the-curtain/blob/main/docs/specification.md) has examples for the official OpenAI SDKs, all settings, and the files that the server writes.

## Notes

- Everything you send is saved to files and read by a human. A request that is refused, such as one with an image, is not saved.
- There is no authentication, and the server only listens on local addresses. Use it only on your own machine.
- Not affiliated with OpenAI, Anthropic, or any other company named here.

## Documentation

- [Specification](https://github.com/two-pack/im-behind-the-curtain/blob/main/docs/specification.md): what the program does, in detail
- [Storage format](https://github.com/two-pack/im-behind-the-curtain/blob/main/docs/storage-format.md): the files of requests and replies
- [Requirements](https://github.com/two-pack/im-behind-the-curtain/blob/main/docs/requirements.md): what the first release must do
- [Contributing](https://github.com/two-pack/im-behind-the-curtain/blob/main/docs/contributing.md): how to build, test and send a change

## License

MIT
