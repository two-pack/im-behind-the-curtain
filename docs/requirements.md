# Requirements

This document lists what `imbehind` must do. Each requirement has a number that does not change, so that tests, the specification and the code can refer to it. [specification.md](specification.md) describes how the first release behaves, and [storage-format.md](storage-format.md) describes the files it writes.

## Purpose

`imbehind` is an API server where a human writes the replies instead of an LLM. A developer can check how an LLM client behaves without a real model, and a person can play the part of the AI.

The first release must let a client that speaks the OpenAI Chat Completions format send a request, let a human type the reply in a terminal, and let the client receive that reply. The round trip is checked against a tool that sends plain HTTP (such as `curl`) and against the official OpenAI SDK.

## Terms

| Term | Meaning |
|---|---|
| request | An HTTP request in the Chat Completions format that a client sends to the server |
| reply | The text that a human types and the server returns to the client |
| request state | Where a request is in its life. See the table below |
| waiting request | A request whose state is `waiting` |
| finished request | A request whose state is not `waiting` |
| wait limit | How long the server waits for a human reply to one request |
| retention | How long a finished request is kept before it is deleted |
| storage directory | The directory that holds the files of requests and replies |
| error shape | The body `{"error": {"message": ..., "type": ..., "code": ...}}`, which follows the OpenAI format |
| local address | An address in `127.0.0.0/8`, the IPv6 address `::1`, or the name `localhost` |

A request is in one of seven states:

| State | Meaning |
|---|---|
| `waiting` | A human reply is awaited |
| `replied` | The reply was returned to the client |
| `skipped` | A human skipped it and the client got an error |
| `cancelled` | The client closed the connection |
| `timed_out` | The wait limit was reached and the client got an error |
| `abandoned` | It was still `waiting` when the server stopped, so the next start ended it |
| `invalid_reply` | A reply file written by a user was not valid, so the client got an error |

## Functional requirements

Each group says whether it is a Must (the first release cannot go without it) or a Should (important, but the product works without it).

### FR1 Receive Chat Completions requests and return replies (Must)

- **FR1.1** The server accepts a JSON request on `POST /v1/chat/completions` that has `model` and `messages`. Any model name is accepted. Any API key, or none, is accepted.
- **FR1.2** A request whose body is not JSON, has no `messages`, has an empty `messages`, or has no `model` gets a client error in the error shape. It is not stored and not shown to the human.
- **FR1.3** Fields that these requirements do not mention are ignored. They are never a reason to refuse a request.
- **FR1.4** An accepted request gets a unique id and the state `waiting`, and it is stored before the human sees it.
- **FR1.5** When the human reply arrives, the server returns a response with these fields:
  - `id` starts with `chatcmpl-` and differs for every request
  - `object` is `chat.completion`
  - `created` is the time the response was made, as Unix time in whole seconds
  - `model` is the model name of the request, unchanged
  - `choices` has one item: `index` 0, `message.role` `assistant`, `message.content` the reply, `finish_reason` `stop`
  - `usage` has `prompt_tokens`, `completion_tokens` and `total_tokens`, all 0
- **FR1.6** A request with `n` of 2 or more is refused with an error, because only one reply can be returned. A missing `n` or an `n` of 1 is accepted.
- **FR1.7** The roles `system`, `developer`, `user`, `assistant`, `tool` and `function` are accepted. Any other role is refused with an error in the error shape. Messages that belong to tools are covered by FR9.
- **FR1.8** A message whose `content` is an empty string or `null` is accepted. The human sees a fixed word that says it is empty.

### FR2 Structured output replies (Must)

- **FR2.1** A request whose `response_format.type` is `json_schema` or `json_object` asks for a JSON reply. Any other request asks for text.
- **FR2.2** For a JSON request, `imbehind answer` says that the reply is JSON. For `json_schema` it also shows the requested shape.
- **FR2.3** A reply that is not valid JSON is not sent. The human is told what is wrong and types the reply again. The request is not lost.
- **FR2.4** The reply is not checked against the requested shape. Valid JSON is sent as it is.
- **FR2.5** The text the human typed is returned unchanged in `message.content`.

### FR3 Streaming (Must)

- **FR3.1** For a request with `stream: true`, the server answers with `Content-Type: text/event-stream` only after the human reply is complete. Each chunk is a line `data: <JSON>` followed by an empty line, and the last line is `data: [DONE]`.
- **FR3.2** Every chunk has `id` (the same in all chunks of a request), `object` `chat.completion.chunk`, `created` (the same in all chunks), `model` (the model name of the request), and one item in `choices` with `index` 0.
- **FR3.3** The first chunk has the delta `{"role": "assistant", "content": ""}`. Then come one or more chunks with the delta `{"content": <reply>}`. The last chunk has the delta `{}` and `finish_reason` `stop`. Earlier chunks have `finish_reason` `null`.
- **FR3.4** A structured output request is streamed in the same form. A reply that calls tools is streamed in the form of FR9.7 and FR9.8.
- **FR3.5** When `stream_options.include_usage` is true, a chunk with an empty `choices` array and a `usage` of zeros is sent just before `[DONE]`.
- **FR3.6** If the request fails before the reply (skipped, timed out and so on), the server does not start a stream. It returns a normal HTTP error in the error shape.

### FR4 The `imbehind answer` command (Must)

- **FR4.1** When no request is waiting, it prints one line that says so and waits for a request.
- **FR4.2** It shows waiting requests one at a time, oldest first. The display has the position (such as 1 of 3), the time of arrival, the model name, the reply kind and the conversation. The conversation shows every `system` and `developer` message and the last three of the other messages, in the order they arrived, each with its role name. When messages are left out, the display says how many and gives the path of the file that holds the whole conversation.
- **FR4.3** The human types the reply directly in the terminal and ends it with Ctrl+D (on Windows: Ctrl+Z, then Enter). Line breaks become `\n` on every operating system, and line breaks at the end are removed.
- **FR4.4** When the reply reaches the client, it prints `Sent.` and shows the next request.
- **FR4.5** If the human ends the input without typing anything, the command asks whether to skip. The default is not to skip; only `y` skips. A skipped request gets an error response and the command prints `Skipped.`. If the input ends during the question, the request is not skipped.
- **FR4.6** If the request ends while the human types, answers the question, or is about to send (the client left or the wait limit passed), the command says that the reply will not be sent, stops the input and moves on to the next request.
- **FR4.7** If two `imbehind answer` commands reply to the same request, only the first reply is used. The other one says that the request was already answered.
- **FR4.8** Ctrl+C ends the command and leaves the shown request waiting.
- **FR4.9** A `content` that is an array of text parts is shown as the parts joined together.
- **FR4.10** Terminal control characters in a request are shown in a visible form and never written to the terminal as they are.
- **FR4.11** If the server is not running or the storage directory cannot be read, the command says why and shows the storage directory.
- **FR4.12** When standard input is not a terminal, the command asks no question. It sends the whole input as the reply to the first waiting request (the one that arrived first) and exits. If no request is waiting, it waits for one. If the input is empty, the request stays waiting and the command exits with a failure code. If the request ends while the input is read or before it is sent, the command says so, names the request and exits with a failure code.
- **FR4.13** The interactive flow can be tested without a terminal, by feeding input lines in order. Showing a request, typing a reply, ending the input and the skip question are all covered this way.
- **FR4.14** If a new request arrives while the human types, the command prints the number of waiting requests in one line. What the human typed is not lost.

### FR5 Several requests at once (Must)

- **FR5.1** The server can hold many waiting requests. Each client receives only the reply to its own request.
- **FR5.2** Requests are shown in the order of their arrival time. For the same time, the order of their ids decides.

### FR6 Cancel, wait limit and restart (Must)

- **FR6.1** A request whose client closed the connection gets the state `cancelled` and is removed from the list that the human sees.
- **FR6.2** The default wait limit is 30 minutes. It can be changed with a command line option or an environment variable. 0 means no limit.
- **FR6.3** A request that reaches the wait limit gets a timeout error response and the state `timed_out`, and is removed from the list.
- **FR6.4** When the server starts and finds requests with the state `waiting` in the storage directory, it sets their state to `abandoned`. Abandoned requests are not shown to the human and are deleted by the retention rule (FR10.5).

### FR7 Model list (Must)

- **FR7.1** `GET /v1/models` returns an object with `object` set to `list` and one or more models. Each model has `id`, `object` set to `model`, `created` and `owned_by`.

### FR8 Refuse parts that are not text (Must)

- **FR8.1** A request with an image part in a message `content` is refused at once, with an error that says images are not supported.
- **FR8.2** A request with any other part that is not text (audio, a file and so on) is refused at once, with an error that names the unsupported part type.
- **FR8.3** A refused request is not stored and not shown to the human.

### FR9 Tools and tool calls (Must)

- **FR9.1** A request whose `tools` or `functions` has one or more definitions is accepted, stored and shown to the human. The entries are not checked, and `tool_choice` and `parallel_tool_calls` are ignored. An empty `tools` or `functions` array is accepted and counts as no definition.
- **FR9.2** A request with a message that has the role `tool` or `function`, or an `assistant` message with `tool_calls` or `function_call`, is accepted and stored. An `assistant` message that has `tool_calls` or `function_call` may leave out `content`. A `content` that is `null` or missing is stored as an empty string. The fields `tool_call_id`, `name`, `tool_calls` and `function_call` of a message are stored as received, even when their form is wrong.
- **FR9.3** `originalRequest` holds the body that the client sent, `tools` and `functions` included, unchanged.
- **FR9.4** `imbehind answer` shows each message with its role name, `tool` and `function` included. For an `assistant` message it shows every call of `tool_calls` and `function_call` with the function name and the arguments, cut to 80 characters of Unicode with `...` at the end when cut. A call that cannot be read is shown as `(unreadable tool call)`. It lists the names of `tools` and `functions`, with `(unnamed)` for an entry without a name, and lists nothing when both are empty or missing. Control characters are shown in a visible form (FR4.10).
- **FR9.5** A reply is a reply that calls tools only when the request has at least one definition in `tools` or `functions` and the reply is a JSON array that is not empty and whose every element is an object with a `function` key. Any other reply is text. A reply file of `kind` `text` and one of `kind` `json` are judged the same way.
- **FR9.6** Tool calls must fit this form: each element has a non-empty string `id` that no earlier element of the reply uses, the `type` `function`, and a `function` with a non-empty string `name` and a string `arguments`. Other fields are allowed. The content of `arguments` is not checked. Tool calls that do not fit are not sent. The human is told which call and which field does not fit, without any typed character, and types the reply again. A reply file with such tool calls ends the request as `invalid_reply`.
- **FR9.7** A reply that calls tools is returned for a request that is not streamed with `message.role` `assistant`, `message.content` `null`, `message.tool_calls` the array as typed, and `finish_reason` `tool_calls`. For a streamed request the chunks come in this order: a first chunk with the delta `{"role": "assistant", "content": null}`; one chunk for each call with a `tool_calls` delta that holds `index` (from 0), `id`, `type` and `function` with `name` and the whole `arguments`; and a last chunk with the delta `{}` and `finish_reason` `tool_calls`. Earlier chunks have `finish_reason` `null`. Fields other than these are dropped from a stream. The usage chunk of FR3.5 stays just before `[DONE]`.
- **FR9.8** When a request defines `functions` and no `tools`, the reply must have exactly one call, in the form of FR9.6. It is returned with `message.content` `null`, `message.function_call` `{"name": ..., "arguments": ...}` and `finish_reason` `function_call`, without `id` and `type`. A stream has one chunk with the delta `{"function_call": {...}}` and a last chunk with `finish_reason` `function_call`. When a request defines both, the form of FR9.7 is used.
- **FR9.9** For a structured output request (FR2.1) that also has tool definitions, a reply that calls tools is accepted and returned as in FR9.7. Any other reply must still be valid JSON (FR2.3).
- **FR9.10** A reply from standard input (FR4.12) is judged by the same rules. If its tool calls do not fit, nothing is sent and the command exits with a failure code.
- **FR9.11** The screen, standard input, the check of a reply file and the response use the same code to tell tool calls from text and to check them, so they cannot disagree.

### FR10 Storage directory and deletion of old files (Must)

- **FR10.1** The default storage directory is the per-user data directory of the operating system. It can be changed with an option or an environment variable.
- **FR10.2** `imbehind path` prints the storage directory on one line. It follows the same options and environment variables as `imbehind serve`.
- **FR10.3** A missing storage directory is created on first use. If it cannot be created or written, the server stops and shows the path and the reason.
- **FR10.4** A file is written under a temporary name and renamed when it is complete, so that a half-written file is never read as a whole one.
- **FR10.5** The default retention is 24 hours, counted from the moment a request finished. It can be changed; 0 means files are never deleted.
- **FR10.6** If both retention and wait limit are not 0 and the retention is shorter than the wait limit, the server stops at start and shows both values.
- **FR10.7** Old files are deleted at start and then at a fixed interval (10 minutes by default; it can be changed). Files of a waiting request are never deleted.
- **FR10.8** Files in the storage directory that this server did not make are neither read nor deleted.
- **FR10.9** Only one `imbehind serve` can use a storage directory. A second one stops with an error that names the directory. If the earlier server ended abnormally, a new one starts without manual cleanup.

### FR11 The `imbehind serve` command (Must)

- **FR11.1** By default it listens on `127.0.0.1:3000` and prints the address it listens on, in one line.
- **FR11.2** The address and the port can be changed with options or environment variables.
- **FR11.3** The address must be a local address. `localhost` is accepted only when every address it names is local. Any other address stops the server with an error that says it cannot be reached from outside this machine.
- **FR11.4** If the port is in use, the server stops with an error that names the port.
- **FR11.5** For each received request, reply, skip, cancel, timeout, switch to `abandoned` and switch to `invalid_reply`, it prints one line with the time, the kind of event and the short id of the request. It never prints what a request or a reply says.
- **FR11.6** Settings come from the command line option first, then the environment variable, then the default. A value that is not valid stops the server with the name of the setting and the form that is allowed.

### FR12 Documents and README (Must)

- **FR12.1** The requirements and the specification are kept in `docs/`, in English.
- **FR12.3** `README.md` and `README.ja.md` describe the first release. They name only the Chat Completions format and the model list. They say that parts that are not text are refused and that `tools`, `tool_calls` and `function_call` are supported.
- **FR12.4** The documents say that the wait time of the client must be raised, and give an example of how.
- **FR12.5** The continuous integration has a job that builds, tests, formats and checks, and starts `imbehind serve` and makes one round trip.

### FR13 Distribution as a package (Should)

- **FR13.1** The program can be obtained through a package manager and started as the command `imbehind`. It is distributed as an npm package.
- **FR13.2** A release is published by a workflow that only a person can start. After it publishes, the workflow installs the published version, starts `imbehind serve` and makes one round trip.

An automated test installs the package that is about to be published from a local file, starts `imbehind serve`, and makes one round trip. The workflow makes the same round trip with the version that was published.

### FR14 Request and reply files (Should)

- **FR14.1** The formats of the request file and the reply file are documented in `docs/storage-format.md`. Every file carries a field for the format version. The `formatVersion` of `request.json` is 2, and the version of the other files is 1. The server reads request files of both versions 1 and 2, and a reader that knows only version 1 treats a version 2 request file as a file it does not understand.
- **FR14.2** If a user puts a reply file in the documented form into the storage directory, the server treats it like a reply from `imbehind answer` and returns it to the client.
- **FR14.3** The documents tell how to write a reply file safely: write it under another name, then give it its final name when it is complete. The server reads only the final name.
- **FR14.4** A reply file is not valid if it is not JSON, lacks a required field, has an unknown format version, holds a non-JSON reply for a JSON request, holds tool calls that do not fit (FR9.6), or is larger than 10 MB. The client gets an error that says the reply was not valid and why, and the state becomes `invalid_reply`.
- **FR14.5** If both `imbehind answer` and a written file reply to the same request, only the one that arrived first is used.

## Non-functional requirements

| ID | Requirement | How it is checked |
|---|---|---|
| NFR1 | Runs on Linux, macOS and Windows. WSL counts as Linux. | All tests pass in CI on the three operating systems |
| NFR2 | All tests are automated and run with the standard command of the language. | One standard command in a fresh clone runs every test |
| NFR3 | New code has at least 80% line coverage. | CI measures coverage and fails below 80% |
| NFR4 | The round trip is tested with a plain HTTP tool and with the official OpenAI SDK. | Both round trips are automated tests that pass in CI. The SDK tests cover replies with and without streaming: the SDK reads the response without an error and the reply text can be taken out. They also cover requests with tools: the SDK reads `tool_calls` and `function_call`, and builds the `tool_calls` of a stream |
| NFR5 | CI checks tests, coverage, formatting and static checks on pull requests to `main` and on pushes to `main`. | A failure in any of them makes the CI result fail |
| NFR6 | A request is shown by `imbehind answer` within 2 seconds of its arrival. | A test measures it on one machine |
| NFR7 | The client receives the response within 2 seconds of the reply being sent. | A test measures it on one machine |
| NFR8 | Ten waiting requests at once are answered without mixing them up. | A test sends ten requests, answers each differently, and checks every reply |
| NFR9 | The server accepts no requests from outside the machine and has no authentication. | The server cannot start on a non-local address (FR11.3) |
| NFR10 | What a request says is written only to files in the storage directory, never to the output of the server. | A test checks that request text does not appear in the output of `imbehind serve` |
| NFR11 | On Linux and macOS, the storage directory and files are created so that only the user who made them can read and write. On Windows the permissions of the user profile apply. | Tests check the permissions on Linux and macOS |
| NFR12 | A request body larger than 10 MB is refused with an error that says it is too large. | A test sends a body a little above and a little below the limit |
| NFR13 | If the server stops while writing, the next start works without manual cleanup. | A test starts the server in a directory that holds a half-written file |
| NFR14 | The display does not rely on color, names states with words, and can be used with the keyboard only. | Tests check the words, and the input-feeding tests reach the reply and the skip using typed characters only |
| NFR15 | Command output, code comments and repository text are English. Only `README.ja.md` is Japanese. | An automated test finds no Japanese characters in the files that go to `main`, other than `README.ja.md` |

## Constraints

- The first release supports the Chat Completions format only. The code keeps the parts that differ between API formats apart, so that other formats can be added later.
- What is documented in `docs/`, what the standard test commands check, and the plain GitHub Actions CI are the source of truth. The project does not depend on any special tool to build, test or use it.
- Tests are written before the code they check, and no test needs a manual step to pass.

## Out of scope

| Item | Decision |
|---|---|
| Anthropic Messages format | Planned as the first addition after the first release |
| OpenAI Responses format | A later release |
| Behavior that depends on `tool_choice` or `parallel_tool_calls` | Will not be built. They are ignored |
| Checking the form of the entries of `tools` and `functions`, or that `arguments` is JSON | Will not be built |
| A response with both text and `tool_calls` | Will not be built |
| A reply written after the human has seen an image | A candidate for a later release. The first release refuses images |
| Merging retried requests that have the same content | A candidate for a later release |
| Checking a structured reply against the requested shape | Will not be built |
| More than one reply to one request | Will not be built |
| Answering many requests from one standard input | Will not be built |
| Sharing one storage directory between servers | Will not be built |
| Authentication and access from outside the machine | Will not be built |
| A screen in a browser | Will not be built |
| Scripted or real LLM replies | Will not be built |
