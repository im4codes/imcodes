# [IM.codes](https://im.codes)

[English](../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

**エージェントのための IM。すべての AI プロバイダーをまたぐ一つのメモリレイヤー。エージェント横断の監査とプランニング。**

IM.codes は coding agent のための、プロバイダーをまたぐ共有メモリレイヤーです。完了した作業を再利用可能なコンテキストとして蓄積し、適切な履歴を後続 session に再注入します。対応先は Claude Code、Codex、Gemini CLI、GitHub Copilot、Cursor、OpenCode、OpenClaw、Qwen などで、ターミナル、ファイル閲覧、Git 変更、localhost プレビュー、通知、マルチエージェント連携、transport 系 agent のネイティブストリーミングも備えています。P2P ディスカッションを内蔵——複数のモデルが互いの計画と実装をレビュー・監査し合い、単一モデルの見落とし・盲点・バイアスを効果的に減らします。

> これは翻訳版です。**正式な内容は英語版 README（`../README.md`）です。** 差異がある場合は英語版を優先してください。

複数のエージェントが CLI と SDK の両方で接続できます。

## スクリーンショット

### デスクトップ

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-sidebar.png"><img src="../landing/imcodes-sidebar.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes0.png"><img src="../landing/imcodes0.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes1.png"><img src="../landing/imcodes1.png" width="24%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes2.png"><img src="../landing/imcodes2.png" width="24%" /></a>
</p>

### iPad / タブレット

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-ipad2.png"><img src="../landing/imcodes-ipad2.png" width="48%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-ipad3.png"><img src="../landing/imcodes-ipad3.png" width="48%" /></a>
</p>

### モバイル

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m6.png"><img src="../landing/imcodes-m6.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m7.png"><img src="../landing/imcodes-m7.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m8.png"><img src="../landing/imcodes-m8.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m5.png"><img src="../landing/imcodes-m5.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m1.png"><img src="../landing/imcodes-m1.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m2.png"><img src="../landing/imcodes-m2.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m3.png"><img src="../landing/imcodes-m3.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m4.png"><img src="../landing/imcodes-m4.png" width="18%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-m0.png"><img src="../landing/imcodes-m0.png" width="18%" /></a>
</p>

### Apple Watch

<p>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch1.png"><img src="../landing/imcodes-watch1.png" width="31%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch0.png"><img src="../landing/imcodes-watch0.png" width="31%" /></a>
<a href="https://raw.githubusercontent.com/im4codes/imcodes/master/landing/imcodes-watch2.png"><img src="../landing/imcodes-watch2.png" width="31%" /></a>
</p>

Apple Watch ではセッションの素早い確認、未読件数、push 通知、手首からのクイックリプライに対応します。

## ダウンロード

<a href="https://apps.apple.com/us/app/im-codes/id6761014424"><img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" height="40" alt="Download on the App Store" /></a>

iPhone、iPad、Apple Watch に対応しています。[Web App](https://app.im.codes) も利用できます。

## なぜ作ったか

デスクを離れると、多くの coding-agent workflow は途切れます。agent は端末で動き続けていても、続きの操作には SSH、`tmux attach`、リモートデスクトップなどが必要になります。

[IM.codes](https://im.codes) はそうした session をモバイルや Web から手の届く場所に保ちます。ターミナルを開き、ファイルや Git 変更を確認し、別デバイスで localhost をプレビューし、作業完了時に通知を受け取り、複数の agent を並行して動かせます。

これは別の AI IDE ではなく、単なる遠隔ターミナルでもありません。端末ベースの coding agents を取り巻くメッセージング / 制御レイヤーです。

## Shared Agent Context とメモリ

IM.codes は完了済みのエージェント作業を継続的に再利用可能な記憶へ変換し、そのコンテキストを後続セッションへ戻します。

- **保存するのは 問題 → 解決 の要約であり、ログのノイズではありません。** 記憶化されるのは最終的な `assistant.text` のみで、ストリーミング delta、tool call、tool result、中間ノイズは除外されます。
- **個人メモリは任意でクラウド同期できます。** 生データと処理済みメモリは常にローカルに残り、処理済み要約だけをユーザー単位のクラウドプールへ同期してデバイス間で共有できます。
- **Enterprise Shared Context は検索・閲覧可能です。** チームは知見を workspace / project スコープに公開し、UI 上で検索・統計確認できるため、見えない prompt 文字列として埋め込まれたままになりません。これはまだ継続開発中で、完全な本番テストは終わっていません。
- **多言語リコール。** ローカルのセマンティック検索と pgvector ベースのサーバーリコールは多言語 embedding を使うため、日本語・英語・中国語・韓国語・スペイン語・ロシア語をまたいで関連修正を見つけられます。
- **メッセージ送信時とセッション起動時に自動注入。** 関連履歴は送信前と起動時の両方で自動注入され、timeline カードに注入理由、関連度スコア、再利用回数、最終使用時刻まで表示されます。
- **ユーザーから見えて制御できる。** Shared Context UI では raw events、processed summaries、cloud memory、enterprise memory を分けて表示し、検索、プレビュー、archive/restore、処理設定を操作できます。

## 主な機能

### リモートターミナル
SSH、VPN、ポート開放なしで、任意のブラウザから agent session の端末に完全アクセスできます。

### ファイルブラウザと Git 変更表示
プロジェクトツリーの閲覧、ファイルのアップロード / ダウンロード、差分確認、プレビューができます。

### ローカル Web プレビュー
ローカルの開発サーバーをデプロイせずに他の端末から表示できます。

### モバイル、Watch、通知
生体認証、push 通知、shell session の入力、Apple Watch での素早い確認と返信に対応します。

### クロスモデル監査と P2P ディスカッション
単一モデルの出力を盲信すべきではありません。P2P ディスカッションでは、異なるプロバイダーや思考スタイルを持つ複数の agent が、コードを書く前に同じコードベースで協調分析を行います。各ラウンドはカスタマイズ可能なマルチフェーズパイプラインに従い、各 agent は前の貢献をすべて読んだ上で出力します。異なるモデルは異なる種類の問題を発見します。このクロスプロバイダー相互審査により、実装前に大部分の問題を発見し、手戻りを大幅に削減できます。

組み込みモードは `audit`（構造化された audit → review → plan パイプライン）、`review`、`discuss`、`brainstorm` で、独自のフェーズ構成も定義可能。Claude Code、Codex、Gemini CLI、Qwen で動作します。

### Streaming Transport Agents
OpenClaw や Qwen のような transport 型 agent に対して、terminal scraping ではなくネイティブなストリーミングを提供します。

### Agent 間通信
`imcodes send` により、ある agent から別の agent へレビューやテスト依頼を直接送れます。

```bash
imcodes send "Plan" "review the changes in src/api.ts"
imcodes send "Cx" "run tests" --reply
imcodes send --all "migration complete, check your end"
```

```python
# monitor.py — watch a log file, trigger agent when errors appear
import subprocess, time

while True:
    with open("/var/log/app.log") as f:
        for line in f:
            if "ERROR" in line:
                subprocess.run([
                    "imcodes", "send", "Claude",
                    f"Fix this error and write the patch to /tmp/fix.patch:\n{line}"
                ])
    time.sleep(30)
```

```bash
# Webhook → agent: GitHub webhook handler triggers code review
curl -X POST https://your-server/webhook -d '{"pr": 42}' \
  && imcodes send "Gemini" "review PR #42, write summary to /tmp/review.md"

# CI → agent: post-build trigger
imcodes send "Claude" "tests failed on main, check CI log at /tmp/ci.log and fix" --reply
```

### スマート `@` ピッカー
`@` でファイル検索、`@@` で P2P 対象の agent を選択できます。

### 複数サーバー / 複数セッション管理
複数の開発マシンをひとつのダッシュボードで扱えます。

### Discord 風サイドバー
サーバー切り替え、階層的な session tree、未読バッジ、固定パネルを備えます。

### 固定パネル
ファイルブラウザ、リポジトリページ、sub-session チャット、ターミナルをサイドバーに固定できます。

### リポジトリダッシュボード
Issue、PR、branch、commit、CI/CD run をアプリ内から確認できます。

### 定期タスク（Cron）
cron 形式で agent workflow を自動化できます。

### 端末間同期
タブ順序や固定パネルはサーバー経由で複数端末に同期されます。

### 国際化
UI は 7 言語に対応しています。

### OTA アップデート
Daemon は npm 経由で自己更新でき、Web UI からも実行できます。

## IM.codes ではないもの

- 別の AI IDE ではない
- 単なるチャットラッパーではない
- 単なるリモートターミナルクライアントではない
- Claude Code、Codex、Gemini CLI、OpenClaw、Qwen の代替ではない
- それらを囲むメッセージング / 制御レイヤーである

## アーキテクチャ

```
You (browser / mobile)
        ↓ WebSocket
Server (self-hosted)
        ↓ WebSocket
Daemon (your machine)
        ↓ tmux / transport
AI Agents (Claude Code / Codex / Gemini CLI / OpenClaw)
        ↔ imcodes send (agent-to-agent)
```

Daemon は開発マシン上で動作し、tmux または transport プロトコルを通じて agent session を管理します。Server は各デバイスと daemon の間を中継します。データは自分のインフラに留まります。

## インストール

```bash
npm install -g imcodes
```

## クイックスタート

> **Self-host を強く推奨します。** 共有インスタンス `app.im.codes` は評価用途のみです。

```bash
imcodes bind https://app.im.codes/bind/<api-key>
```

このコマンドはマシンをバインドし、daemon を起動し、システムサービスとして登録して、Web / モバイルのダッシュボードに表示します。

### OpenClaw 接続

OpenClaw がローカルで動作している場合、daemon マシン上で IM.codes を OpenClaw gateway に接続できます。

```bash
imcodes connect openclaw
```

このコマンドは次を行います。

- 既定で `ws://127.0.0.1:18789` に接続
- `~/.openclaw/openclaw.json` の token を自動再利用
- OpenClaw の main / child session を IM.codes に同期
- `~/.imcodes/openclaw.json` に設定を保存
- daemon を再起動して自動再接続を有効化

```bash
imcodes connect openclaw --url ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=... imcodes connect openclaw
imcodes connect openclaw --url wss://gateway.example.com
```

注意:

- TLS なしのリモート `ws://` には `--insecure` が必要
- `imcodes disconnect openclaw` で保存設定を削除して切断可能
- このフローは現在 macOS でのみ検証済み

## Self-Host

### ワンコマンドセットアップ

```bash
npm install -g imcodes
mkdir imcodes && cd imcodes
imcodes setup --domain imc.example.com
```

### 手動セットアップ

```bash
git clone https://github.com/im4codes/imcodes.git && cd imcodes
./gen-env.sh imc.example.com        # generates .env with random secrets, prints admin password
docker compose up -d
```

生成される `docker-compose.yml` は PostgreSQL に `pgvector/pgvector:pg16` を使用します。

## Windows（実験的）

```cmd
npm install -g imcodes
imcodes bind https://app.im.codes/bind/<api-key>
```

```cmd
imcodes upgrade
```

```cmd
imcodes repair-watchdog
```

```cmd
npm prefix -g
```

```cmd
setx PATH "<npm-prefix-path>;%PATH%"
```

```
%USERPROFILE%\.imcodes\watchdog.log
```

## 要件

- macOS または Linux
- Windows（実験的、ConPTY 経由）
- Node.js >= 22
- Linux / macOS では tmux
- Claude Code、Codex、Gemini CLI、OpenClaw、Qwen のいずれか

## 免責事項

IM.codes は独立したオープンソースプロジェクトであり、Anthropic、OpenAI、Google、Alibaba、OpenClaw などとは提携・承認・支援関係にありません。

## ライセンス

[MIT](../LICENSE)

© 2026 [IM.codes](https://im.codes)
