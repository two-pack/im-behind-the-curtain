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

どちらのコマンドも、Ctrl+Cで終えられます。`imbehind serve` を終えたとき、誰も返答していないリクエストは保存先にそのまま残り、次の `imbehind serve` が `abandoned` で終えます（「保存先」の節を見てください）。`imbehind answer` は、`imbehind serve` が動いている間だけ起動できます。

### 構造化出力

リクエストの `response_format` の `type` が `json_schema` か `json_object` のとき、`imbehind answer` は `Reply:    JSON` と表示します。`json_schema` では、求められている形を `Required shape:` の下に表示します。`json_object` では、JSONとして読めればどんな値でもよいことを表示します。JSONを打ち込み、Ctrl+Dで終えます。Windowsでは、Ctrl+Zを押してからEnterを押します。

- 返答は、RFC 8259のJSONとして読める必要があります。最上位はどんな値でもよく、空白は許されます。コメント、末尾のカンマ、`NaN`、`Infinity` は許されません。読めないときは何も送りません。`imbehind answer` は、`Not sent: your reply is not valid JSON (...)` と、読めなくなった行と桁を表示し、同じリクエストの入力に戻ります。
- 求められている形に合うかは確かめません。JSONとして読めれば、形に合わない返答もそのまま送ります。
- 返答は、打ち込んだとおりの文字列で `choices[0].message.content` に入ります。

### ストリーミング

リクエストに `"stream": true` があるときは、返答を書いている間、何も送りません。書き終えると、サーバーは返答の全体を `text/event-stream` で送ります。内容は、役割の断片、返答の全体を入れた断片1つ、`stop` の断片、`data: [DONE]` の順です。`"stream_options": {"include_usage": true}` があるときは、`[DONE]` の前に、`choices` が空でトークン数がすべて0の断片を1つ足します。`"stream": true` がないリクエストには、これまでどおりのJSONの応答を返します。構造化出力も同じ形でストリーミングできます。

リクエストを保存できなかったときは、ストリームを始めずに、通常のJSONのエラーを返します。`imbehind serve` の `received` の行には、構造化出力なら `json`、ストリーミングなら `stream` が付きます。例は `chat/completions  json  stream` です。

### リクエストの中身

発言の `content` には、文字列、`null`（`(empty)` と表示します）、文章の部品の配列（`{"type": "text", "text": "..."}`。区切りなしでつなげます）を指定できます。`system`、`developer`、`user`、`assistant` 以外の役割、形のおかしい部品、2以上の `n` は、`400` のエラーで断ります。人間が読めない、または行えない内容を求めるリクエストは、`code` が `unsupported_content` の `400` のエラーで断ります。断るのは、文章でない部品（画像、音声、ファイル）、1件以上の定義がある `tools` と `functions`、役割が `tool` か `function` の発言、`tool_calls` か `function_call` を持つ `assistant` の発言です。空の `tools` と `functions` は受け付けます。知らない項目は無視します。本文が10 MB（10485760バイト）を超えるリクエストは、`413` と `request_too_large` で断り、何も保存しません。

`imbehind answer` は、`system` と `developer` の発言をすべて、それ以外は最後の3件を表示します。発言を省いたときは、`(3 earlier messages omitted. Full conversation: <path>)` のような行を1つ表示します。`<path>` は、会話の全体を入れた `request.json` の場所です。200行を超える発言は、200行で切り、同じような行を足します。改行とタブ以外の制御文字は、`\xNN`（たとえば `\x1b`）の形で表示します。

リクエストは保存先に保存されます（「保存先」の節を見てください）。保存先はハードリンクを作れる必要があります。

`imbehind serve` が受け付けるのは、`POST /v1/chat/completions` に届く文章のメッセージです。`GET /v1/models` にも答えます。ブラウザが付ける `Origin` ヘッダーのあるリクエストと、`Host` ヘッダーが手元の名前でないリクエストは断ります。手元の名前とは、`127.0.0.0/8` の範囲のアドレス（`127.0.0.1` など）、`[::1]`、`localhost` です。大文字と小文字は区別せず、ポートはあってもなくてもかまいません。

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

## 設定

`imbehind serve` には6つの設定があります。それぞれ、起動時の指定があればそれを使い、なければ環境変数、それもなければ既定値を使います。空の環境変数は、指定なしとして扱います。起動時の指定は `--port 3100` でも `--port=3100` でも書けます。

| 起動時の指定 | 環境変数 | 既定値 | 意味 |
|---|---|---|---|
| `--host` | `IMBEHIND_HOST` | `127.0.0.1` | 待ち受けるアドレス。手元のアドレスだけが使えます。`127.0.0.0/8` の範囲のアドレス、`::1`（`[::1]` とも書けます）、そして、名前に当たるアドレスがすべて手元のものである `localhost` です。 |
| `--port` | `IMBEHIND_PORT` | `3000` | ポート。1から65535まで。 |
| `--dir` | `IMBEHIND_DIR` | OSごとの保存先。「保存先」の節を見てください | 保存先のディレクトリ。相対パスは、コマンドを起動した場所からの絶対パスにします。 |
| `--timeout` | `IMBEHIND_TIMEOUT` | `1800` | 返答を待つ上限の秒数。0から2147483まで。`0` は上限なし。 |
| `--retention` | `IMBEHIND_RETENTION` | `86400` | 終わった依頼を残す秒数。0から315360000まで。`0` は消さない。 |
| `--sweep-interval` | `IMBEHIND_SWEEP_INTERVAL` | `600` | 古い依頼を探す間隔の秒数。1から2147483まで。 |

`imbehind answer` と `imbehind path` が受け取るのは `--dir` と `IMBEHIND_DIR` だけです。`imbehind serve` と同じ保存先を使います。`--port` など `imbehind serve` だけの指定を渡すと、使い方の行を表示して終わります。

`--retention` と `--timeout` がどちらも0でないときは、`--retention` を `--timeout` より短くできません。待っている間に依頼が消えるおそれがあるためです。値の確認は、何かを作ったり開いたりする前に、次の順で行います。コマンドの書き方、`--host`、`--port`、`--timeout`、`--retention`、`--sweep-interval`、`--dir`、最後に保存期間と待つ上限の組み合わせです。最初に見つかった問題を1行だけ表示し、ほかには何もしません。

```
Error: 0.0.0.0 is not a local address. imbehind only listens on this machine (127.0.0.0/8, ::1, localhost).
Error: --port must be a number from 1 to 65535 (got "abc").
Error: --retention (600 seconds) must not be shorter than --timeout (1800 seconds).
```

終了コードは次のとおりです。0は成功で、`imbehind path` が返します。1は、起動できないとき、または保存先を読めないときです。使われているポート、使えないアドレス、別の `imbehind serve` が使っている保存先、`imbehind answer` に対して `imbehind serve` が動いていない場合がこれに当たります。2は、コマンドの書き方の誤りと、認められない値です。130はCtrl+Cです。

## 保存先

既定の保存先は、Linuxでは `$XDG_DATA_HOME/imbehind`、`XDG_DATA_HOME` が未設定なら `~/.local/share/imbehind` です。macOSでは `~/Library/Application Support/imbehind`、Windowsでは `%LOCALAPPDATA%\imbehind` です。`imbehind path` は、そのときの指定と環境変数で決まる保存先を1行で表示し、終了コード0で終わります。何も作らず、何も読まないので、最初の起動より前にも使えます。

```sh
imbehind path
IMBEHIND_DIR=/data/imbehind imbehind path
```

保存先を作るのは `imbehind serve` だけです。`imbehind answer` は作りません。

- **権限** LinuxとmacOSでは、`imbehind serve` が作るフォルダはすべてモード `0700`、ファイルはすべてモード `0600` にします。使えるのは自分だけです。すでにあるフォルダの権限は変えません。自分で置いた `reply.json` の権限も変えません。Windowsではモードを設定せず、利用者のプロファイルの権限がそのまま使われます。
- **1つの保存先に1つのserve** `imbehind serve` は、保存先に `serve.lock` を書き、5秒ごとに書き直します。同じ保存先で2つ目の `imbehind serve` を起動すると、`Error: <保存先> is already used by another imbehind serve.` と表示して止まります。強制終了された `imbehind serve` が残した印は、そのプロセスがなくなったとき、または最後の書き直しが15秒より前のときに、次の起動が自分で引き継ぎます。このプログラムの印として読めない `serve.lock` は、読まず、消しません。どの `imbehind serve` も使っていないなら自分で消すよう案内して止まります。
- **再起動** `imbehind serve` の起動の前から待っていた依頼は、たとえば前のserveをCtrl+Cで止めた場合などですが、最初の行のすぐあとに `abandoned` で終えます。1件につき1行で、`14:00:00 abandoned  c9d0e1  server restarted` の形です。クライアントはもういないので、`imbehind answer` には出ません。
- **古い依頼** 終わった依頼は、終わってから `--retention` 秒が過ぎると、フォルダごと消えます。既定は24時間です。確認は起動のときに1回と、そのあと `--sweep-interval` 秒ごとに行います。既定は10分です。待っている依頼は消しません。フォルダの中が `request.json`、`state.json`、`reply.json`、`reply.accepted.json` だけのときに限って消します。ほかのファイルが1つでもあれば、そのまま残し、`imbehind serve` がその依頼について `14:05:12 error      a1b2c3  kept unknown files` の形の行を1回表示します。`--retention 0` では何も消しません。点で始まる名前のファイルとフォルダ、このプログラムが作っていないファイルは、読まず、消しません。
- **serveが動いていないとき** `imbehind serve` が動いていないと、`imbehind answer` は終了コード1で終わり、`Error: imbehind serve is not running for <保存先>.` と `Start it with: imbehind serve` を表示します。保存先を読めないときは `Error: cannot read <保存先>: <理由>.` を表示します。確かめるのは起動のときの1回です。

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

- 送った内容はファイルに保存され、人間が読みます。画像入りなど、断ったリクエストは保存しません。
- 認証はありません。手元のマシンの中だけで使ってください。
- OpenAI、Anthropicほか、名前を挙げた各社とは関係ありません。

## ライセンス

MIT
