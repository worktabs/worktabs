# 開発

[English](../development.md) | **日本語**

エージェント向けのソース構成は [AGENTS.md](../../AGENTS.md) に、仕組みは [architecture.md](architecture.md) にあります。

## エージェントのセッション

新しいエージェントのセッションでは、確認を動かす前に `package-lock.json` どおりの依存を入れます。

```sh
npm ci --no-audit --no-fund
```

これは Codex、Claude Code、ほかのエージェントに共通のセットアップです。`npm run check` と `npm test` にはこれで足ります。Claude Code remote のセッションでは、便利機能として `.claude/hooks/session-start.sh` も同じ install を自動で行います。ただし、共有の手順はこのページと [AGENTS.md](../../AGENTS.md) を正として扱います。

## そのまま起動する

```sh
npm install
node node_modules/electron/install.js   # Electron 44 は本体を初回にダウンロードする
npm run build:native                    # Windows のラッパーと補助拡張の VSIX を作る（Windows 付属の csc.exe と tar.exe を使用）。macOS では VSIX だけ
cp config.example.json config.local.json
npm start
```

- Node.js 22 以降を使います。CI が使う版は `.nvmrc` にあります（`nvm use` や `fnm use` がこれを読みます）。`.editorconfig` は、これを読むエディタに、インデントと改行コードを指定します。
- Electron アプリ、code-server、native wrapper、補助拡張の VSIX、インストーラー、手元での UI 確認が必要なときに、この手順を使います。エージェントだけで扱うコードやドキュメントの変更では、ふつうは上のセットアップとテストだけで足ります。
- `config.local.json` の `repos` に、自分のリポジトリを書きます。このファイルは環境ごとに違うので git には入れません。別の場所に置く場合は、`WORKTABS_CONFIG` でパスを指定します。書ける項目は [config.md](config.md) にあります。
- Claude Code（VS Code 拡張）から起動する場合は、環境変数 `ELECTRON_RUN_AS_NODE` が引き継がれて Electron が Node として動いてしまいます。先に `unset ELECTRON_RUN_AS_NODE` してください（`env -u ELECTRON_RUN_AS_NODE npm start` でも構いません）。
- インストーラーと zip の作り方は [install.md](install.md) にあります。

## アプリのアイコン

Worktabs のマークは、重なった 3 つのエディタのウィンドウで、Tokyo Night に倣った青と紫の配色です。Worktabs 自身のマークで、エージェントの提供元のロゴは使っていません。

`build/icon.svg` を編集してから、`npm run build:icons` を実行します。ライトの版、複数のサイズを含む Windows の ICO と macOS の ICNS、`src/assets/` にある実行中に使う PNG、`docs/images/social-preview.png`（1280 × 640。リポジトリのソーシャルプレビュー用）を作ります。作ったファイルは、SVG と一緒にコミットします。アプリをビルドしたりインストールしたりするときに、作り直す必要はありません。

実行ファイル、インストーラー、macOS のバンドルは、ダークのアイコンを使います。Worktabs の起動中は、macOS の Dock のアイコンと Windows のウィンドウのアイコンが、OS のライト／ダークに合わせて変わります。Windows では、システムの外観（Windows のモード）に従います。これは、アプリのモードとは違うことがあります。前に出ている VS Code のテーマとは関係ありません。Windows のショートカットとタスクバーにピン留めしたものは、パッケージのアイコンのままのことがあります。README にも、ダークとライトの版があります。

起動中の切り替えには PNG を、macOS のバンドルには固定の ICNS を使います。Icon Composer は使わず、Finder のアイコンも外観に合わせては変えません。絵を編集したら、Windows と macOS で、小さいサイズと両方の外観を確かめます。

## テスト

```sh
npm test        # 単体テスト（test/*.test.js、node:test）
npm run check   # すべての JavaScript ファイルの構文チェック
npm run lint    # 推奨ルールでの ESLint（eslint.config.js）
npm run typecheck  # TypeScript で JavaScript とその JSDoc の型を確かめる（jsconfig.json）
npm run coverage   # カバレッジを取りながら単体テストを動かす。package.json のしきい値を下回ると失敗する
```

- Electron や VS Code がなくても動くモジュール（`src/conversations/hooks.js`・`src/agents/usage.js`・`src/repos/worktrees.js`・`src/repos/github.js`・`src/repos/clone.js`・`src/conversations/notifications.js`・`src/repos/task.js`・`src/wsl/wsl.js`・`src/wsl/wsl-agent.js`・`src/code-server/code-server-wsl.js`・`src/code-server/settings-sync.js`・`src/code-server/jsonc.js`・`src/window/theme.js`・`src/conversations/secondary-sidebar.js`・`src/window/sidebar-width.js`・`src/window/message-box.js`・`src/dialog/keys.js`・`helper-extension/location.js`）を確かめます。Linux でも動くので、Claude Code on the web などのクラウドの環境でも使えます。
  - WSL のエージェント（`src/wsl/wsl-agent.js`）のテストは、ファイルの操作と見張りのほかは Linux でだけ動きます（`/proc` を読むため）。Windows では、WSL の中で `node --test test/wsl-agent.test.js` を実行します。
  - claude のラッパーのテストは、claude の代わりのプロセスを包んで、出力をそのまま流すことと `rate_limit_event` を送ることを確かめます。材料は `test/wrap-fixture.js` で共通です。
    - `test/claude-wrap.test.js`（Windows）は、`native/ClaudeWrap.cs` を一時フォルダにビルドして確かめます。
    - `test/mac-claude-wrap.test.js`（Windows 以外）は、アプリが書き出すのと同じ sh のスクリプト越しに `src/agents/mac-claude-wrap.js` を動かします。Linux でも動くので、CI でも走ります。
  - リリースノートのテスト（`test/release-notes.test.js`）は、一時フォルダのリポジトリで git-cliff（npm で入ります）に `CHANGELOG.md` を作らせ、`cliff.toml` の分類と、そこからのリリースノートの取り出しを確かめます。
  - サイドバーの画面のテストは、`src/sidebar/index.html` に並ぶスクリプトを、ページと同じ順にまとめて、小さな DOM の材料と一緒に読み込みます。材料のタイマーは、ブラウザと同じく、正しくない受け手（`this`）で呼ぶとエラーにします。GitHub のリポジトリの場面で、読み込み中の CI、起動時とエージェントのバッジの変化、アーカイブのクリック、アーカイブした会話が戻ることを確かめます。これらは `npm test` と CI で動きます。材料では Chromium のレイアウトや実際の入力は確かめられないので、下の手元での Electron の確認も続けます。
- GitHub Actions では、PR と main への push ごとに Ubuntu と Windows でテストし、Windows で `npm run pack` まで行います（`.github/workflows/ci.yml`）。
  - Ubuntu では `npm run typecheck` も実行します。TypeScript の型チェッカー（`tsc`）で、JavaScript とその JSDoc の型を確かめます。メインプロセスは `jsconfig.json` で、画面はそれぞれのプロジェクト（`src/sidebar/jsconfig.json`・`src/dialog/jsconfig.json`）で確かめます。
  - Ubuntu では、テストを `npm run coverage` で動かします。`src/` と `helper-extension/` について Node のカバレッジを取り、行・分岐・関数のカバレッジが `package.json` のしきい値を下回ると失敗にします。カバレッジが上がったら、しきい値も上げます。下げるのは、PR に理由を書いたときだけです。
  - Ubuntu では `npm audit --omit=dev --audit-level=high` も実行します。アプリに入るパッケージに high か critical の勧告（advisory）があると、失敗にします。開発用のツールの勧告では失敗にしません。利用者のマシンには届かないためです。
  - Ubuntu では、スモークチェック（`npm run smoke`。下記）も実行します。Electron の本体と Linux 版の code-server はキャッシュするので（code-server は版ごと）、どちらかが変わったあとの最初の実行でだけダウンロードします。スモークチェックが失敗したときは、アプリと code-server のログを `smoke-logs` の artifact として残します。
  - いまは Windows と macOS を止めて、Ubuntu だけでテストしています。2026 年 10 月に Actions の予算を使い切ったためです。Windows は `ci.yml` の matrix に `windows-latest` を戻し、macOS は `gh workflow enable "CI (macOS)"` で戻します。止めている間は、Windows と macOS のテストを手元で動かしてからマージします。リリースも、タグを push せずに手元で作ります（[releasing.md](releasing.md#いまは手元でビルドして配る)）。
  - main への push では、ドキュメントだけの変更（docs/、README.md、README.ja.md、AGENTS.md、CLAUDE.md、CHANGELOG.md と、.github/ の CONTRIBUTING.md・CODE_OF_CONDUCT.md・SECURITY.md・issue と PR のテンプレート）なら動かしません。テストが読まず、アプリにも入らないためです。PR では、ドキュメントだけの変更でも毎回動かします。main は `Test (ubuntu-latest)` のチェックが通った PR しか受け付けないので、チェックが動かないと PR が待ったままになるためです。
  - PR に新しく push すると、まだ動いている前の実行は止めます。main への push は、マージのコミットごとに最後まで動かします（サイドバーが、マージ済みの PR の行にその CI を出すため）。
- Dependabot（`.github/dependabot.yml`）が、npm のパッケージと GitHub Actions を毎週確かめます。それぞれの minor と patch の更新は 1 つの PR にまとめて来て、major の更新は 1 つずつ別の PR で来ます。Electron の major の更新は、マージする前に Windows と macOS で動かします。
- macOS では、毎晩 3 時すぎ（日本時間）に、main の先頭をテストし、`npm run pack:mac` まで行います（`.github/workflows/mac.yml`）。
  - push では動かしません。GitHub はジョブごとに分を切り上げて数え、macOS は 10 倍で数えるので、20 秒で終わるジョブでも 10 分ぶんになるためです。
  - main の先頭を macOS でテストし終えていれば（前の晩か手動で）、動かしません。それを見るのに Ubuntu で 1 分ほど使います。
  - PR のうちに macOS で確かめるときは、`gh workflow run mac.yml --ref <ブランチ>` で動かします。
  - リリースでは、これとは別に、macOS でもテストしてからビルドします（[releasing.md](releasing.md)）。
- どのジョブも 10 分で打ち切ります。テストが終わらないと、GitHub の上限の 6 時間まで動き続けるためです。
- 画面、code-server、Claude Code 拡張とのやりとりは確かめられません。下の開発用チェックで、Windows か macOS の実機で確かめます。下のスモークチェックは、主な流れについて、Linux でアプリ全体を動かします。

## Linux でのスモークチェック

`npm run smoke`（`scripts/smoke-check.js`）は、Linux でアプリ全体（Xvfb の中の Electron と、Linux 版の code-server）を起動し、開発用の制御ポートから動かします。タブを開いて VS Code を読み込む、worktree を（`.worktreeinclude` のファイル付きで）追加してブランチごと削除する、アカウントのリポジトリをクローンする、メッセージ・設定・拡張・worktree の追加・クローンのダイアログを開く、サイドバーの IPC のチャンネルを呼ぶ、ひとりでに終わった code-server を確かめる、タブを休止する、終了したあとに code-server が残っていないことを確かめる、の順に進みます。手順ごとに `PASS` か `FAIL` を出し、1 つでも失敗すると 1 で終わります。

CI は、PR ごとに Ubuntu でこれを動かします。クラウドのセッションのように Windows も macOS もないところでは、単体テストで見えない変更（`main.js`、画面、code-server を扱う部分）を、手元でこれで確かめます。`main` でも動かします。手順が失敗したときに、変更が壊したのか、もともと失敗していたのかが分かります。実機での確認の代わりにはなりません。Windows と macOS そのもの、WSL のタブ、通知、本物の Claude Code 拡張と Codex 拡張は、実機で確かめます。

```sh
sudo apt-get install -y xvfb            # または DISPLAY のあるところで動かす
node node_modules/electron/install.js   # Electron の本体
npm run smoke                           # -- --offline でクローンを省く。-- --keep でフォルダを残す
```

- 自分のものは何も使いません。新しいフォルダ（`$TMPDIR/worktabs-smoke`、または `--work <フォルダ>`）で、専用のデータフォルダ・設定ファイル・git のリポジトリを使い、gh（github.com にサインイン済みで、octocat/Hello-World を自分のリポジトリとするもの）と ghq（リポジトリを 1 つ返すもの）の代わりを `PATH` に置きます。Open VSX に届かないことがあるので、Claude Code 拡張は、同じ ID の空の代わりです。
- code-server は、`~/.cache/worktabs-smoke`（`--cache <フォルダ>`）に 1 回だけダウンロードします。クローンの手順は github.com/octocat/Hello-World をクローンします。`--offline` で省きます。制御ポートは 47831 です（`--port <番号>`）。
- 手順が失敗したときは、フォルダを残します。アプリのログ（`app.log`）と code-server のログ（`data/logs/`）があります。
- プロキシの内側では、Electron のダウンロードに `ELECTRON_GET_USE_PROXY=1` と `GLOBAL_AGENT_HTTPS_PROXY`（プロキシのアドレスを設定）が要ります。curl は `HTTPS_PROXY` を使います。
- Xvfb では、サイドバーの端をマウスでドラッグすると、すぐに終わってしまいます（ビューが広がるときに、Chromium がボタンを押していないマウスの移動を送るため）。そこでチェックは、端をマウスで押し、ドラッグは IPC で行います。

## Codex の会話の状態を確かめる

プラットフォーム、拡張の版、プロバイダーの選択、失敗、ライフサイクルの結果は、[Codex の検証の表](codex-verification.md)に記録します。オフラインの材料でのテストが通っても、サインインした公式の拡張での確認が済んだことにはなりません。

補助拡張か Windows のランチャーを変えたら、`npm run build:native` を実行します。アプリのエージェントの設定で Codex を有効にし、Codex 拡張にサインインしたタブを開きます。そのタブでは、拡張の CLI のパスをアプリが管理します。ブランチ名を考えるときも、PATH にある CLI ではなく、選んだエージェントの拡張に付属する CLI を使います。

自動テストは、プロトコルのアダプター、同時に来る承認の求め、中断、プロセスの持ち主、パイプの転送、止めるときの危険を確かめます。次の確認には、さらに本物の拡張と、Windows か macOS のマシンが要ります。

- ターンを動かし、ほかのタブに切り替えて、作業中のバッジ、会話の行、経過時間、上端の数を確かめます。
- ターンに、コマンド、ファイル、権限の承認を求めさせます。承認待ちのバッジ、数、通知、次の承認待ちへの移動を確かめます。開く会話は、承認を求めている会話でなければなりません。
- 2 つの会話を同時に承認待ちにします。一方に答えて、もう一方が承認待ちのままなことを確かめます。ターンを拒否するか中断して、その承認待ちが消えることを確かめます。
- 裏でターンを終わらせ、失敗するターンも起こします。完了・エラーのバッジ、通知、未読の結果、通知のクリックを確かめます。結果を開いて、未読が消えることを確かめます。
- 会話が作業中か承認待ちの間に、閉じる、休止、再起動を試します。どれも警告を出さなければなりません。タブのほかの会話がエラーになっているときも同じです。自動の休止では、作業中のタブを動かしたままにしなければなりません。
- 1 つのタブに Codex のスレッドを 2 つ置きます。それぞれの行をクリックして、エディタのタブを作らずに、チャットのサイドバーがまさにそのスレッドを出すことを確かめます。
- タブを休止するか止めて、ラッパーのプロセスが消え、使った Codex のスレッドは待機中の履歴の行として残ることを確かめます。Worktabs を再起動し、補助拡張が登録を済ませる前に、保存された行をクリックします。起動のあとに、そのスレッドが開かなければなりません。
- 待機中の Codex の行を Worktabs のアーカイブのボタンで隠し、再起動します。隠れたままでなければなりません。Codex の履歴から新しいプロンプトを送って、行を戻します。動いている Codex 拡張でスレッドをアーカイブか削除して、その保存された行が消えることを確かめます。
- ないスレッドと、Codex 拡張のないタブを試します。黙って失敗するのではなく、警告を出し、代わりにサイドバーを出すことを確かめます。

Windows では、状態と移動の確認を WSL のタブでも繰り返します。macOS では、アプリが動いている間に、シェルのランチャーと通知のクリックを確かめます。Windows のランチャーには、それを強制終了して、その app-server のプロセスのツリーが止まることを確かめるテストがあります。CLI の差し替えとサイドバーの URI ハンドラーは、拡張との接点なので、Codex を更新したら確認を繰り返します。

Codex の承認の設定については、単体テストが、調べた 2 つの形のピッカー、使えない選択肢と制限された選択肢、分からない機能、拒まれた選択、設定の保存、明示した選択、履歴の移動、更新とダウングレードの検出を確かめます。本物の拡張での確認も、まだ要ります。

### Windows で確かめること

- [ ] 対応している拡張で新しい会話を始め、「Approve for me」になっていることを確かめます。サンドボックスの外の操作を求めさせ、自動の審査が動き、その拒否が効いたままなことを確かめます。
- [ ] Worktabs の設定で「承認を求める」を保存します。新しい会話、ほかの worktree のタブ、タブの開き直し、Worktabs の再起動を確かめます。前からある会話と、入力欄で明示して選んだものが、そのモードのままなことを確かめます。
- [ ] 対応する WSL の拡張と実行環境のそれぞれで繰り返します。古い拡張、制限されたアカウント、前の版の拡張に戻したときを試します。手動の承認に戻ることと、ユーザーのターンを足さずに履歴を移れることを確かめます。

### mac で確かめること

- [ ] 対応している拡張で新しい会話を始め、「Approve for me」になっていることを確かめます。サンドボックスの外の操作を求めさせ、実際の審査を、拒否とエラーのときの動きも含めて確かめます。
- [ ] 「承認を求める」を保存します。新しい会話、ほかの worktree のタブ、開き直し、再起動を確かめます。前からある会話と、明示して選んだものはそのままにします。
- [ ] 古い拡張、制限されたアカウント、前の版に戻したときを試します。手動の承認に戻ること、履歴の移動、ユーザーのターンが足されないことを確かめます。

この設定は、拡張の画面の内部の接点を使います。インポートした Codex の版を変えたら、これらの確認を繰り返します。ピッカーの操作に失敗したときや、知らない形のピッカーでは、拡張のモードをそのままにします。Codex 全体の設定は変えません。

任意の統合テストは、ほかと切り離した Electron のアプリと code-server を、オフラインの拡張の材料で起動します。新しいエディタのタブを作らずにサイドバーで開くこと、2 つのスレッド、再起動のあとのメタデータ、起動中に待たせたクリック、休止、アーカイブの印を確かめます。子のスレッドへ直接移ること、サブエージェントの札、子の完了が届かなかったときに親の協働の状態から取り戻すこと（緑の未読のバッジや、回る印を残さずに）も確かめます。先に補助拡張をビルドし、`WORKTABS_TEST_CODE_SERVER_DIR` に手元で展開した code-server のリリースを設定して、`node --test test/codex-navigation.test.js` を実行します。たとえば PowerShell では、次のとおりです。

```powershell
npm run build:native
$env:WORKTABS_TEST_CODE_SERVER_DIR = 'C:\path\to\code-server'
node --test test/codex-navigation.test.js
```

この環境変数がなければ、テストは飛ばします。材料はログインせず、推論の要求も送りません。確かめるのは Worktabs と code-server での移動で、公式の Codex 拡張のスレッドの中身や承認ではありません。上の本物の拡張での確認も続けます。

同じ準備で `node --test test/startup.test.js` を実行すると、空の拡張フォルダと、わざと止めたインストールでの起動を確かめます。早いうちにタブを開くこと、切り替え、閉じて開き直すこと、保存した履歴、インストールの失敗を確かめます。成功する場合は、本物の code-server のプロセスを起動して、補助拡張、チャットのサイドバー、VS Code の言語を確かめます。日本語の場合も含めるときは、`WORKTABS_TEST_LANGUAGE_PACK_DIR` に、手元に入れた `ms-ceintl.vscode-language-pack-ja` 拡張のフォルダを設定します。テストは、切り離したアプリのデータと、空のエージェントのホームを使います。エージェントの拡張はダウンロードせずに、ビルドした補助拡張とオフラインのチャットの材料を入れます。起動の確認は、Windows と macOS で、公式のエージェントの拡張を使って、UI の両方の言語で繰り返します。

## 開発用チェック

未読の確認には、`test/seen-conversations.test.js` の単体テストのほかに、本物のエージェントの拡張が要ります。どちらかの拡張を更新したら、繰り返します。知らない形の入力欄では、未読の印を残します。

### Windows で確かめること

- [ ] Claude を出しているとき、同じタブの Codex の結果は未読のままです。その Codex のスレッドに切り替えると、その結果だけが既読になります。エージェントを入れ替えても、WSL でも繰り返します。
- [ ] 1 つのエージェントに未読の会話が 2 つあるとき、一方を出すと、その会話だけが既読になります。パネルの中で、読み込み済みの会話の間を切り替えます。
- [ ] 緑の会話の行をクリックして、その行だけが既読になることを確かめます。移動に失敗したときは、結果は未読のままです。
- [ ] チャット欄を隠してから、タブを開くか、ウィンドウにフォーカスを移します。未読は残ります。Claude の会話をエディタに出して、その結果だけが既読になることを確かめます。
- [ ] 前に出ていてフォーカスのあるタブで、ほかのチャットが完了すると、通知なしで未読になります。裏のタブと、非アクティブなウィンドウでは、今までどおり通知を出します。

### mac で確かめること

- [ ] WSL を除いて、上の Windows の確認を繰り返します。両方のエージェントのパネル、履歴の切り替え、隠したチャット欄、エディタのチャット欄、行のクリック、ウィンドウのフォーカス、通知を確かめます。

### webview の互換性の確認

単体テストは、見えているかどうか・承認・オンボーディングを調べる仕組みで、マウントした React の材料と、形の違う React の材料を共通で使います。スレッドの切り替え、置き換わったり外れたりした DOM のノード、ないルート、形の崩れたツリー、たどる数の上限、文字列にしたスクリプト、入れ直し、片付けたあとに届いた結果を確かめます。どちらかのエージェントの拡張を更新したり前の版に戻したりしたら、本物の拡張での確認を繰り返します。

- [ ] Windows では、手元と WSL のタブで、見えているかどうか、履歴、承認の選択とその確認を繰り返します。制限された形や対応していない形の承認を確かめ、拡張の自動の審査が今までどおり効くことを確かめます。準備の途中で、チャット欄を置き換えるか開き直します。
- [ ] macOS では、パネルの置き換えと Worktabs の再起動も含めて、手元の確認を繰り返します。知らない形の拡張では、未読の印と、拡張のいまのモードをそのままにしなければなりません。
- [ ] どちらのプラットフォームでも、primary 以外の worktree を、その primary の worktree の前と後に開きます。知っているオンボーディングの案内を、完了のコールバックを通して飛ばすのは、primary 以外の worktree だけです。primary の worktree のオンボーディングは別のままで、関係のない認証の画面も使えるままです。

下のスクリプトは、開発用の制御ポートから、起動したアプリを動かして確かめます（Windows のみ。制御ポートそのものは macOS でも開きます）。

- `WORKTABS_CONTROL_PORT`（または設定の `controlPort`）を設定すると、開発用の制御ポートが開きます。普段は設定しないでください。
  - どの要求にも、アプリが起動時に作るトークンが要ります。アプリはそれをデータフォルダの `control-token` に、自分のユーザーだけが読めるように書き、`scripts/dev-lib.js` がそこから読みます（スクリプトにも、アプリと同じく `WORKTABS_DATA_DIR` を設定します）。アプリを自分で起動するスクリプトは、代わりに `WORKTABS_CONTROL_TOKEN` でトークンを決められます。
  - ポートは、Web のページからの要求（`Origin` ヘッダーのあるもの）と、`127.0.0.1` と `localhost` 以外のホスト名での要求を断ります。
  - 使えないポートを指定したときは、アプリは止まらずに制御ポートなしで動きます（標準エラーに `control port <番号>: listen EADDRINUSE ...` と出ます）。何かのソフトが予約しているポートの範囲は、`netstat` にも `netsh int ipv4 show excludedportrange` にも出ないことがあります（開発機では 44620〜48715 が使えず、47821 もこの範囲でした）。
- インストール版の Worktabs を使いながら開発する場合は、`WORKTABS_DATA_DIR` で別のデータフォルダを指定します。データフォルダが同じだと二重起動の防止で終了してしまいます。
- `WORKTABS_HIDDEN=1` を付けると、ウィンドウを出さずに起動します（制御ポートからの確認用。画面の撮影はできません）。
  - 隠したウィンドウでは、マウスの移動が画面に届くのが大きく遅れます（Chromium はマウスの移動を画面の描画に合わせて送り、隠れた画面は描画しないため）。マウスを動かすチェック（`dev-sidebar-width-check.js`・`dev-close-all-check.js`）は、ウィンドウを出して動かします。
  - 隠したウィンドウでは、ダイアログの答えもアプリに届きません。ダイアログの画面は、ボタンを押した次の描画で答えを送るためです（`src/dialog/dialog.js` の `answer`）。答えるチェック（`dev-close-all-check.js` など）は、ウィンドウを出して動かします。
- データフォルダには短いパスを使ってください。パスが長いと（Claude Code の scratchpad のような 120 文字を超えるフォルダなど）、Chromium が webview のキャッシュ（Cache Storage）を開けず、Claude のパネルが真っ白になります。短い名前のジャンクション（`mklink /J`）を通しても構いません。
  - 開くフォルダのパスに、`\c` のあとに英字以外が続くところ（scratchpad の `\claude\c--...` など）があると、code-server のファイルの見張り（parcel）が正規表現のエラー（`regex_error`）で止まります（`logs\` の下の `remoteagent.log`）。
- 確認スクリプトは、UI がどちらの言語でも動きます。アプリの文言を確かめるところでは、アプリにどの言語で動いているかを聞き（制御ポートの `language`）、`src/i18n/` から文言を取ります（`scripts/dev-lib.js` の `appText`）。

```sh
WORKTABS_CONTROL_PORT=47821 npm start
WORKTABS_DATA_DIR=<別のフォルダ> WORKTABS_CONFIG=<設定ファイル> WORKTABS_HIDDEN=1 WORKTABS_CONTROL_PORT=47821 npm start   # インストール版と並べて起動
node scripts/dev-github-check.js <フォルダ> [<フォルダ> ...]                          # GitHub のボタンと、行の PR と CI（ブラウザは開かない）
node scripts/dev-check.js <別の worktree> <プロンプトを送る worktree> "<プロンプト>"   # バッジの遷移
node scripts/dev-conversations-check.js <別の worktree> <会話を始める worktree>       # 会話ごとの行（片方が作業中に完了した会話、前に出す、閉じる）
node scripts/dev-behind-check.js <worktree>                                         # 右のパネルの背後の会話（行で切り替える、アーカイブ、プロンプトで一覧に戻る）
node scripts/dev-focus-check.js <worktree>                                          # 右のパネルとエディタのタブのチャット欄で、フォーカスを奪い合わない
node scripts/dev-suspend-check.js <タブ名>                                            # 休止と復帰
node scripts/dev-resume-content-check.js <タブ名>                                     # 会話内容の復元
node scripts/dev-reopen-check.js <フォルダ> [<別のフォルダ>]                            # 閉じたタブを開き直す（同じポート、開いていたファイル。別のフォルダのタブがそのポートを取らない）
node scripts/dev-chat-view-check.js <アプリで開いたことのないフォルダ>                     # 右のサイドバーが組み込みのチャットから Claude Code に替わる（フォーカスは動かない）。閉じた右のサイドバーは、開き直しても閉じたまま
node scripts/dev-chat-width-check.js <リポジトリを作るフォルダ>                          # 初めて開いたタブの右のチャット欄の幅（primary は 2:1、worktree は primary の幅。primary を閉じても tabs.json から。自分で変えた幅は開き直してもそのまま）。リポジトリを作り、worktree を 2 つ足して消す。ウィンドウが狭いと 2:1 が 300 ピクセルになるので、広くして動かす
node scripts/dev-unsaved-check.js <タブ名>                                            # 未保存編集の検出（自動保存を切った状態で）
node scripts/dev-update-check.js <タブ名> [--idle]                                     # 更新の流れ（古い版を入れたデータフォルダで）
node scripts/dev-settings-check.js <main worktree> <その別の worktree>                 # VS Code の設定の共有（実行中・休止・新しい worktree・削除。確認用のリポジトリで。worktree を 1 つ足して消す）
node scripts/dev-dialog-check.js <タブ名>                                              # ダイアログ（キー、順番待ち、フォーカスの戻り、出したまま閉じる）
node scripts/dev-sidebar-width-check.js                                             # サイドバーの幅（ドラッグ中の重ね方、タブの追従、最小・最大、ダブルクリック。WORKTABS_DATA_DIR があれば window.json も）
node scripts/dev-press-check.js <サイドバーのリポジトリ名>                                # 押してから離すまでに行を作り直しても、クリックが効く（押したままなら 2 秒まで作り直さない）
node scripts/dev-close-all-check.js <リポジトリのフォルダ> <その別の worktree> <別のリポジトリのフォルダ> <git でないフォルダ>   # リポジトリのタブをすべて閉じる（確認は 1 回、移り先、ダブルクリックの 2 回目で上がってきた行のタブを閉じない、ポートが残る。最初のリポジトリの名前が先に並び、どちらも GitHub にないもので）
node scripts/dev-add-worktree-check.js <main worktree> <issue か PR の番号>             # issue か PR から worktree を追加（名前を考える・PR のブランチ、右のチャット欄の入力欄、preferredLocation が戻る、行の #番号。最後に消す）
node scripts/dev-wsl-check.js '\\wsl.localhost\<ディストリ名>\<worktree>'              # WSL のタブ（claude が WSL の中で動く、閉じると WSL の中のプロセスも止まる）
```

ログは、データフォルダの `logs\` にあります（[config.md](config.md#ログ)）。

## リリース

版の上げ方、CHANGELOG、GitHub Releases への出し方は [releasing.md](releasing.md) に、コミットと PR の決まりは [CONTRIBUTING.md](../../.github/CONTRIBUTING.md)（英語）にあります。
