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

リクエストはOSごとの利用者のデータ用ディレクトリに保存されます。Linuxは `$XDG_DATA_HOME/imbehind`、未設定なら `~/.local/share/imbehind` です。macOSは `~/Library/Application Support/imbehind`、Windowsは `%LOCALAPPDATA%\imbehind` です。保存先はハードリンクを作れる必要があります。

この版の `imbehind serve` は、`127.0.0.1:3000` だけで待ち受けます。受け付けるのは、`POST /v1/chat/completions` に届く文章のメッセージです。ブラウザが付ける `Origin` ヘッダーのあるリクエストと、`Host` ヘッダーが `127.0.0.1` でも `localhost` でもないリクエストは断ります。

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
