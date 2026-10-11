# im-behind-the-curtain

人間がLLMの代わりに返答を書くAPIサーバーです。サーバーはリクエストを受け取るとファイルに書き出し、人間が返答を書くと、それをレスポンスとして返します。

[English](README.md)

## CLI

```
imbehind serve    # http://127.0.0.1:3000 でAPIを起動する
imbehind answer   # リクエストを読んで、返答を打ち込む
imbehind path     # ファイルの保存先を表示する
```

## 使い方

Node.js 22以降が必要です。このリポジトリをcloneしたフォルダで、最初に一度ビルドします。そのあと2つの端末で、2つのコマンドを動かします。

```sh
npm ci
npm run build
node dist/bin.js serve    # 端末1: http://127.0.0.1:3000 でAPIを起動する
node dist/bin.js answer   # 端末2: リクエストを表示して、返答を打ち込む
```

以降は、この2つのコマンドを `imbehind serve` と `imbehind answer` と書きます。

1. `imbehind serve` を起動します。待ち受けるアドレスと保存先を1行で表示します。そのあとは、リクエストを受け取るたび、返答を返すたびに1行ずつ表示します。リクエストや返答の中身は表示しません。
2. `imbehind answer` を起動します。リクエストが届くまで `Waiting for requests...` と表示します。
3. リクエストを送ります。例にある `curl` のコマンドで送れます。リクエストは、返答が届くまで接続を保ったまま待ちます。
4. `imbehind answer` がリクエストを表示します。届いた時刻、モデル名、会話を表示し、会話の各発言の上に役割の名前 `System`、`Developer`、`User`、`Assistant` を付けます。
5. 返答を打ち込み、Ctrl+Dで終えます。Windowsでは、Ctrl+Zを押してからEnterを押します。改行は `\n` にそろえ、末尾の改行は取り除きます。空の返答は送りません。
6. `curl` は、打ち込んだ文章を `choices[0].message.content` に入れたChat Completions形式の応答を受け取ります。`imbehind answer` には `Sent.` と表示されます。

どちらのコマンドも、Ctrl+Cで終えられます。誰も返答していないリクエストは保存先に残り、次に `imbehind answer` を起動したときにもう一度表示されます。

### 構造化出力

リクエストの `response_format` の `type` が `json_schema` か `json_object` のとき、`imbehind answer` は `Reply:    JSON` と表示します。`json_schema` では、求められている形を `Required shape:` の下に表示します。`json_object` では、JSONとして読めればどんな値でもよいことを表示します。JSONを打ち込み、Ctrl+Dで終えます。Windowsでは、Ctrl+Zを押してからEnterを押します。

- 返答は、RFC 8259のJSONとして読める必要があります。最上位はどんな値でもよく、空白は許されます。コメント、末尾のカンマ、`NaN`、`Infinity` は許されません。読めないときは何も送りません。`imbehind answer` は、`Not sent: your reply is not valid JSON (...)` と、読めなくなった行と桁を表示し、同じリクエストの入力に戻ります。
- 求められている形に合うかは確かめません。JSONとして読めれば、形に合わない返答もそのまま送ります。
- 返答は、打ち込んだとおりの文字列で `choices[0].message.content` に入ります。

### ストリーミング

リクエストに `"stream": true` があるときは、返答を書いている間、何も送りません。書き終えると、サーバーは返答の全体を `text/event-stream` で送ります。内容は、役割の断片、返答の全体を入れた断片1つ、`stop` の断片、`data: [DONE]` の順です。`"stream_options": {"include_usage": true}` があるときは、`[DONE]` の前に、`choices` が空でトークン数がすべて0の断片を1つ足します。`"stream": true` がないリクエストには、これまでどおりのJSONの応答を返します。構造化出力も同じ形でストリーミングできます。

リクエストを保存できなかったときは、ストリームを始めずに、通常のJSONのエラーを返します。`imbehind serve` の `received` の行には、構造化出力なら `json`、ストリーミングなら `stream` が付きます。例は `chat/completions  json  stream` です。

### リクエストの中身

発言の `content` には、文字列、`null`（`(empty)` と表示します）、文章の部品の配列（`{"type": "text", "text": "..."}`。区切りなしでつなげます）を指定できます。それ以外の部品、`system`、`developer`、`user`、`assistant` 以外の役割、2以上の `n` は、`400` のエラーで断ります。知らない項目は無視します。本文が10 MB（10485760バイト）を超えるリクエストは、`413` と `request_too_large` で断り、何も保存しません。

`imbehind answer` は、`system` と `developer` の発言をすべて、それ以外は最後の3件を表示します。発言を省いたときは、`(3 earlier messages omitted. Full conversation: <path>)` のような行を1つ表示します。`<path>` は、会話の全体を入れた `request.json` の場所です。200行を超える発言は、200行で切り、同じような行を足します。改行とタブ以外の制御文字は、`\xNN`（たとえば `\x1b`）の形で表示します。

リクエストはOSごとの利用者のデータ用ディレクトリに保存されます。Linuxは `$XDG_DATA_HOME/imbehind`、未設定なら `~/.local/share/imbehind` です。macOSは `~/Library/Application Support/imbehind`、Windowsは `%LOCALAPPDATA%\imbehind` です。保存先はハードリンクを作れる必要があります。

この版の `imbehind serve` は、`127.0.0.1:3000` だけで待ち受けます。受け付けるのは、`POST /v1/chat/completions` に届く文章のメッセージです。ブラウザが付ける `Origin` ヘッダーのあるリクエストと、`Host` ヘッダーが `127.0.0.1` でも `localhost` でもないリクエストは断ります。

### 依頼を飛ばす

何も打ち込まずに入力を終えると（たとえば最初にCtrl+Dを押すと）、`imbehind answer` は `Skip this request? The client will receive an error. [y/N]` と聞きます。`y` か `Y` だけが、その依頼を飛ばします。クライアントには、コードが `skipped_by_human` の `503` のエラーが届き、`imbehind answer` は `Skipped.` と表示し、`imbehind serve` は `skipped` の行を表示します。Enterだけの場合を含め、ほかの答えでは飛ばさず、返答の入力に戻ります。この質問の途中で入力が終わったときは、何も送りません。`imbehind answer` は `Error: input ended. Nothing was sent; the request is still waiting.` と表示し、終了コード1で終わります。

### 複数の依頼

複数のクライアントが同時に待てます。`imbehind answer` は、古い依頼から1件ずつ表示し、そのたびに件数を数え直します。たとえば `--- Request 1 of 3 (...)` です。打ち込み中に新しい依頼が届くと、`New request received. 2 requests are waiting.` と表示します。件数には、いま返答している依頼も含めます。打ち込んだ内容は失われません。

`imbehind answer` は、2つの端末で動かせます。両方が同じ依頼に返答したときは、先の返答だけが使われ、もう一方は `Not sent: this request was already answered in another window.` と表示します。

### クライアントが切れたとき、待つ上限

返答の前にクライアントが接続を閉じると、その依頼は `cancelled` で終わります。`imbehind answer` は、打ち込み中でもすぐに知らせます（`Cancelled: the client disconnected. Your reply will not be sent.`）。打ち込んだ内容は捨て、次の依頼へ進みます。`imbehind serve` は `cancelled  <id>  client disconnected` と表示します。

`imbehind serve` は、既定で1800秒（30分）、返答を待ちます。`--timeout <秒>` か環境変数 `IMBEHIND_TIMEOUT` で変えられます。両方あるときは起動時の指定が優先で、空の環境変数は指定なしとして扱います。値は0から2147483までの整数の秒数で、`0` は上限なしです。指定できるのは `imbehind serve` だけです。

```sh
imbehind serve --timeout 600
IMBEHIND_TIMEOUT=600 imbehind serve
```

上限に達すると、クライアントには、コードが `reply_timeout` の `504` のエラーと、`No reply within <limit> seconds. Increase the server timeout or reply sooner.` というメッセージが届きます。`imbehind serve` は `timed_out` の行を表示し、その依頼に返答していた `imbehind answer` は `Timed out: the request waited longer than <limit> seconds. Your reply will not be sent.` と表示します。認められない値は、`Error: --timeout must be a whole number of seconds from 0 to 2147483 (got "abc").` のような行を表示して起動をやめ、終了コード2で終わります。

### クライアント側の待ち時間と送り直し

サーバーは自分の上限まで待ちますが、クライアントはそれより先にあきらめることがあります。クライアントの待ち時間は、`imbehind serve` の待つ上限以上にし、自動の送り直しは切ってください。PythonとNodeの公式OpenAI SDKは、待ち時間が既定で600秒です。`408`、`409`、`429`、`5xx` の応答と、接続の失敗のあとに、最大2回、同じ依頼を送り直します。既定のままだと、飛ばした依頼（`503`）や時間切れの依頼（`504`）が送り直され、新しい依頼として現れます。600秒より長く待つ依頼は、SDKが先に切って `cancelled` で終わり、これも送り直されます。次の設定にすると、1件の依頼を30分待ち、送るのは1回だけです。

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

## 開発

```sh
npm ci
npm run check    # 型の検査、lintと整形の確認、カバレッジ付きのテスト、knip、依存の向きの規則。ネットワークなしで動く
npm test         # テストだけ。行と分岐のカバレッジは80%以上が必要
npm run audit    # npm audit。ネットワークが必要
```

依存パッケージを入れても、gitのフックは変わりません。コミットの前に `npm run check` を動かしたいときは、自分でフックを入れてください。これは任意です。

```sh
npm run hooks:install    # このcloneの core.hooksPath を .githooks にする
```

`core.hooksPath` を設定すると、このcloneでは `.git/hooks/` の下にあるフックが動かなくなります。すでにそこにフックを置いている場合は、`.githooks/` へ移すか、この手順を省いてください。

## エンドポイント

| 使う場面 | エンドポイント |
|---|---|
| そのほかのOpenAI互換クライアント | `POST /v1/chat/completions` |
| モデル一覧 | `GET /v1/models` |

モデル名とAPIキーは何でもかまいません。

### 例

```sh
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"whatever","messages":[{"role":"user","content":"Hello"}]}'
```

## 注意

- 送った内容は、画像も含めてファイルに保存され、人間が読みます。
- 認証はありません。手元のマシンの中だけで使ってください。
- OpenAI、Anthropicほか、名前を挙げた各社とは関係ありません。

## ライセンス

MIT
