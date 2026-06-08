# [IM.codes](https://im.codes)

[English](../README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Español](README.es.md) | [Русский](README.ru.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

**エージェントのための IM。共有メモリ、OpenSpec Auto Deliver、管理対象 MCP ツール、監督付き実行、人間同士の協調、そして AI プロバイダー横断の監査。**

<!-- TODO(native-review): JA hero couplet — 默认「天下」(可换「乾坤」);「三人の孔明」措辞待母语者确认 -->
> 三人寄れば文殊の知恵。<br>
> されど三人の孔明、談笑のうちに天下を定む。<br>
> — IM.codes

IM.codes は coding agent のための、プロバイダーをまたぐ共有メモリレイヤーと管理対象 MCP tool surface です。完了した作業を再利用可能なコンテキストとして蓄積し、適切な履歴を後続 session に注入または recall します。対応先は Claude Code、Codex、Gemini CLI、GitHub Copilot、Cursor、OpenCode、OpenClaw、Qwen などで、ターミナル、ファイル閲覧、Git 変更、localhost プレビュー、通知、マルチエージェント連携、transport 系 agent のネイティブストリーミングも備えています。OpenSpec Auto Deliver は変更を proposal/spec 監査から実装、検証ヒント、Team 監査/手戻り、自動モジュール採点、最終 quality gate まで進められます。セッション共有も live agent session を中心に pair / multi-person 協調プログラミングを支えます。内蔵の Auto supervision は完了済みターンを判定し、自律的な継続や監査/手戻りループまで行ったうえで制御を返せます。Team ディスカッションを内蔵——複数のモデルが互いの計画と実装をレビュー・監査し合い、単一モデルの見落とし・盲点・バイアスを効果的に減らします。

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

それは問題の半分にすぎません。複雑な coding-agent 作業には、より安定した判断も必要です。単一モデルは慣れた型に寄り、問題を見落としたり、難しいタスクで出力が不安定になったりします。provider を切り替えると新しい視点は得られますが、共有コンテキストがなければ流れやプロジェクト記憶も失われます。

[IM.codes](https://im.codes) はその両方のために作られています。そうした session をモバイルや Web から手の届く場所に保ち、ターミナルを開き、ファイルや Git 変更を確認し、別デバイスで localhost をプレビューし、作業完了時に通知を受け取り、別の人を同じ session や server に招待し、複数の agent を並行して動かせます。さらに、下の「Shared Agent Context とメモリ」と「クロスモデル監査と Team ディスカッション」を組み合わせます。永続的なリコールは完了作業の要約メモリから来て、Team ディスカッションはコードが入る前の構造化されたクロスモデルレビューです。出力を完璧にはしませんが、単一モデルの盲点を減らし、複雑な作業をより多くのレビューで収束しやすくします。

これは別の AI IDE ではなく、単なる遠隔ターミナルでもありません。端末ベースの coding agents を取り巻くメッセージング、メモリ、レビューのレイヤーです。

## OpenSpec Auto Deliver

OpenSpec ベースの変更では、Auto Deliver が change folder を end-to-end の監督付き delivery run に変えます: proposal/spec review、実装、検証、Team audit、自動モジュール採点、rework gate、見える最終 handoff まで扱います。

- **ワンクリックの change pipeline。** transport-backed coding session から起動します。IM.codes は owner session を解決し、衝突を避けるため Team lane をロックし、`tasks.md` を読み、UI に live run projection を表示します。
- **実装前の spec audit。** 任意の proposal/spec audit-repair は通常の Team flow（既定 `audit>review>plan`）を使い、chat summary ではなく authoritative JSON を読みます。
- **タスク駆動の実装ループ。** daemon は同じ session に focused implementation prompt を送り、その OpenSpec change だけを扱い、checked/unchecked tasks を追跡し、project manifests から見つけた安全な validation command 候補を表示します。
- **自動モジュール採点。** 各 audit は `spec`、`tasks`、`implementation`、`tests`、`risk` の structured scores を出し、evidence と summary は run details に表示されます。
- **実装 audit と rework gate。** 採点付き final verdict — `PASS`、`REWORK`、`BLOCKED` — により、pass するか、limit 内で repair するか、人間判断に戻すかを決めます。
- **Fail-closed と人間の最終制御。** audit output 不正、limit 到達、manual interference、Team state 不整合、tasks unreadable では human input を求めます。code の stage、commit、push は行いません。

## 協調プログラミング

現在のタブ、サブセッション、または source server 全体を他のユーザーに共有できます。`viewer` は read-only review、`participant` は対象 session への prompt 送信に使います。Shared message には actor label が付き、access は UI で降格または取り消しできます。

## Shared Agent Context とメモリ

IM.codes は完了済みのエージェント作業を継続的に再利用可能な記憶へ変換し、そのコンテキストを後続セッションへ戻します。

- **保存するのは 問題 → 解決 の要約であり、ログのノイズではありません。** 記憶化されるのは最終的な `assistant.text` のみで、ストリーミング delta、tool call、tool result、中間ノイズは除外されます。
- **個人メモリは任意でクラウド同期できます。** 生データと処理済みメモリは常にローカルに残り、処理済み要約だけをユーザー単位のクラウドプールへ同期してデバイス間で共有できます。
- **Enterprise Shared Context は検索・閲覧可能です。** チームは知見を workspace / project スコープに公開し、UI 上で検索・統計確認できるため、見えない prompt 文字列として埋め込まれたままになりません。これはまだ継続開発中で、完全な本番テストは終わっていません。
- **多言語リコール。** ローカルのセマンティック検索と pgvector ベースのサーバーリコールは多言語 embedding を使うため、日本語・英語・中国語・韓国語・スペイン語・ロシア語をまたいで関連修正を見つけられます。
- **メッセージ送信時とセッション起動時に自動注入。** 関連履歴は送信前と起動時の両方で自動注入され、timeline カードに注入理由、関連度スコア、再利用回数、最終使用時刻まで表示されます。
- **ユーザーから見えて制御できる。** Shared Context UI では raw events、processed summaries、cloud memory、enterprise memory を分けて表示し、検索、プレビュー、archive/restore、処理設定を操作できます。

## 管理対象 MCP ツール

IM.codes は、対応する SDK 型 provider に daemon 管理の stdio MCP server を公開します。Agent は、同じ runtime scope のツール面で memory、agent-to-agent messaging、scheduled follow-up を扱えます。生の auth token や ad hoc shell command は不要です。

- **メモリ検索と provenance。** `search_memory` は caller-bound memory namespace から、過去の作業、project history、decisions、preferences、bugs、commits、deployments、以前の議論コンテキストを検索します。`list_memory_summaries` は query なしで recent compact summaries を取得します。結果には compact refs と `projectionId` が含まれます。正確な過去指示、bug detail、commit/deployment context、source evidence が必要なときは、`get_memory_sources` が関連 hit を provenance snippets に展開します。
- **メモリ書き込み。** `save_observation` は有用な事実、決定、実装メモを user-private memory candidate として保存します。`save_preference` は安定したユーザー preference を明示的な preference path で保存します。
- **Agent messaging。** `send_list_targets` は現在 project 内の sibling sessions を列挙し、`send_message` は同じ guarded `imcodes send` pipeline で scoped message、任意の file path reference、reply request、broadcast を送信します。
- **Cron scheduling。** `cron_create`、`cron_list`、`cron_update`、`cron_delete` は、reminder、recurring check、delegated review、scheduled Team follow-up のための future structured sends を管理し、target/session/project、expiration、timezone fields を扱えます。
- **Runtime-bound identity と安全性。** Tool call は runtime で現在の IM.codes session、project、user、server に束縛されます。Agent は namespace、user、server、token、routing fields を偽造できません。Memory、Send、Cron は underlying feature gates と MCP kill-switch の両方で保護されます。
- **運用上の可視性。** Shared Context UI は provider ごとの MCP readiness、tool-family gate、degraded reason、update time、daemon-redacted recent tool calls を表示し、その model が本当に Memory、Send、Cron を使えるか確認できます。

## 監督付き実行と Auto Audit

IM.codes は、自分で書いた supervisor の指示で、対応する agent session をターン単位で駆動できます —— 各完了ターンを idle 境界で構造化判定し、auto-continue するか、制御を返すか、audit ループを起動するかを決定します。毎ラウンド手動で "continue" を打つ必要はありません。

- **セッション単位の Auto モード。** `off`、`supervised`、`supervised_audit` をセッションごとに設定でき、全体に一つの方針を強制しません。
- **idle 境界での完了判定。** ターン完了時に IM.codes は `complete`、`continue`、`ask_human` を判定し、次の continue prompt を同じ session に送り返せます。
- **fail-closed な自動化。** Auto supervision は timeline/footer に可視のまま残り、構造化された判定を使い、タイムアウト・不正出力・設定不備時には推測せずユーザーへ制御を返します。
- **任意の audit → rework ループ。** `supervised_audit` では、完了ターンを自動で監査パイプラインに通し、必要なら同じ session に手戻り brief を戻してから制御を返せます。
- **グローバル既定値 + セッションごとの上書き。** 既定の supervisor backend/model/timeout を一度決めておき、必要に応じて backend/model/timeout・監査モード・カスタム指示を各 session で上書きできます。
- **実際の IM.codes workflow を前提。** Auto supervision は OpenSpec 作業、Team レビュー/議論、`imcodes send` によるエージェント間連携を「人間待ち」の理由ではなく、エージェントが続けるべき正当な次の一手として扱います。

## 主な機能

### リモートターミナル
SSH、VPN、ポート開放なしで、任意のブラウザから agent session の端末に完全アクセスできます。

### ファイルブラウザと Git 変更表示
プロジェクトツリーの閲覧、ファイルのアップロード / ダウンロード、差分確認、安全な HTML クイックプレビューができます。チャット内のローカル画像リンクはインラインで表示され、クリックするとフローティング表示で拡大できます。

### ローカル Web プレビュー
ローカルの開発サーバーをデプロイせずに他の端末から表示できます。

### モバイル、Watch、通知
生体認証、push 通知、shell session の入力、Apple Watch での素早い確認と返信に対応します。

### OpenSpec Auto Deliver
spec-driven change を structured pipeline で進めます: proposal/spec audit、implementation prompts、manifest-aware validation hints、Team audit/rework、spec/tasks/implementation/tests/risk の自動採点、fail-closed handoff。

### 協調プログラミング
live session を他の人に共有して pair programming したり、viewer/participant roles で scoped server workspace に複数人を招待できます。

### クロスモデル監査と Team ディスカッション
単一モデルの出力を盲信すべきではありません。Team ディスカッションでは、異なるプロバイダーや思考スタイルを持つ複数の agent が、コードを書く前に同じコードベースで協調分析を行います。各ラウンドはカスタマイズ可能なマルチフェーズパイプラインに従い、各 agent は前の貢献をすべて読んだ上で出力します。異なるモデルは異なる種類の問題を発見します。このクロスプロバイダー相互審査により、実装前に単一モデルが見落としがちな問題を発見し、手戻りを減らせます。

組み込みモードは `audit`（構造化された audit → review → plan パイプライン）、`review`、`discuss`、`brainstorm` で、独自のフェーズ構成も定義可能。Claude Code、Codex、Gemini CLI、Qwen で動作します。

### Streaming Transport Agents
OpenClaw や Qwen のような transport 型 agent に対して、terminal scraping ではなくネイティブなストリーミングを提供します。

### 管理対象 MCP ツール面
対応する SDK provider は、IM.codes 管理の 10-tool MCP surface を自動で受け取れます。memory search/source lookup、observation/preference capture、scoped Send、Cron scheduling を含みます。UI には provider ごとの ready/degraded state が表示され、Memory、Send、Cron がその model で実際に使えるか分かります。

### Agent 間通信
`imcodes send` により、ある agent から別の agent へレビューやテスト依頼を直接送れます。

同じ flow は MCP でも SDK 型 agent に公開されます。`send_list_targets` が有効な sibling target を見つけ、`send_message` が scoped text、file references、reply requests、broadcasts を送ります。生の routing credential は公開されません。

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
`@` でファイル検索、`@@` で Team 対象の agent を選択できます。

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

SDK 型 agent も MCP 経由で同じ scheduler を操作できます。`cron_create`、`cron_list`、`cron_update`、`cron_delete` により、reminder、recurring check、delegated review、follow-up の structured send を作成でき、現在の project/session identity に束縛されたまま動作します。

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
        ↓ tmux / transport / managed MCP
AI Agents (Claude Code / Codex / Gemini CLI / OpenClaw)
        ↔ imcodes send (agent-to-agent)
```

Daemon は開発マシン上で動作し、tmux による process-backed sessions と、SDK / network protocols による transport-backed sessions を管理します。また、runtime-scoped Memory、Send、Cron tools を対応 SDK provider に公開する managed MCP server も所有します。Server は各デバイスと daemon の間を中継します。データは自分のインフラに留まります。

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

生成される `docker-compose.yml` は PostgreSQL に `pgvector/pgvector:pg18` を使用します。

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
