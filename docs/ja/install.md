# インストール

[English](../install.md) | **日本語**

[Releases](https://github.com/worktabs/worktabs/releases) から、Windows はインストーラーか zip を、macOS は zip を取ります。ソースからビルドすることもできます（下記「ソースからビルドする」）。

## 必要なもの

- Windows 11、または macOS（確認したのは Windows 11 と macOS 26.5（Apple Silicon））
- git
- （任意）ghq。サイドバーのリポジトリ一覧は、`ghq list` と手動で追加したリポジトリから作ります
- （任意）WSL2。WSL の中のリポジトリも開けます（[wsl.md](wsl.md)）。WSL の中にも git が要ります
- ソースからビルドするときは、Node.js と npm も要ります

code-server と拡張（Claude Code と、VS Code を英語以外で表示するときはその言語パック）は、初回起動時にアプリが自動で取得します。code-server は GitHub のリリースから約 200 MB、Claude Code 拡張は Open VSX から約 110 MB です。

Claude には、デスクトップの VS Code は要りません。Codex は、「設定 > 拡張」から、デスクトップの VS Code か VSIX ファイルで、対応する公式の拡張をインポートします。インポート元は最新に保ち、ときどきインポートし直します。Open VSX にない拡張は、互換性があることと、発行元の許可が要ります（[extensions.md](extensions.md)）。

## ダウンロードする

Releases の各版に、次のファイルがあります。どれも、GitHub Actions がその版のタグのコミットから作ったものです（[releasing.md](releasing.md)）。変わったことは、各版のリリースノートと [CHANGELOG.md](../../CHANGELOG.md) にあります。

| ファイル | 中身 |
|---|---|
| `Worktabs-<版>-setup.exe` | Windows のインストーラー |
| `Worktabs-<版>-win.zip` | Windows の、展開して使う版 |
| `Worktabs-<版>-arm64-mac.zip` | macOS（Apple Silicon）の `Worktabs.app` |
| `SHA256SUMS.txt` | 上の 3 つの SHA-256 |

ダウンロードしたファイルが途中で壊れたり、すり替わったりしていないかは、SHA-256 を `SHA256SUMS.txt` と見比べて確かめます。

```powershell
Get-FileHash .\Worktabs-0.2.0-setup.exe   # SHA256SUMS.txt の同じ名前の行と同じなら正しい（大文字と小文字は問わない）
```

Git Bash などでは、`sha256sum -c SHA256SUMS.txt --ignore-missing` で、ダウンロードしたものをまとめて確かめられます。macOS では、`shasum -a 256 Worktabs-<版>-arm64-mac.zip` の出力を、`SHA256SUMS.txt` の同じ名前の行と見比べます。

リポジトリを公開したあとの版には、どのコミットから作ったかの証明（GitHub の Artifact attestation）も付きます。`gh attestation verify <ファイル> -R worktabs/worktabs` で確かめられます。

## インストーラーと zip（Windows）

- インストーラーはユーザー単位のインストールで、管理者権限は要りません。
- zip は、好きなフォルダに展開して `Worktabs.exe` を起動するだけで使えます。インストールは要りません。
  - フォルダはあとで移しても構いません。Claude のラッパー（`resources\native\claude-wrap.exe`）のパスは、起動のたびに書き直します。
  - やめるときはフォルダごと消します。設定とデータ（[config.md](config.md)）は残ります。
- どちらも署名していないので、ダウンロードしたものは初回に SmartScreen の警告が出ます。「詳細情報」→「実行」で進めてください。
- 設定ファイルは、どちらも `%APPDATA%\Worktabs\config.json` です。サイドバーの上端の「＋」にある「リポジトリを追加…」と、「…」にある「設定ファイルを開く」から編集できます。書ける項目は [config.md](config.md) にあります。
  - code-server・拡張・開いていたタブも同じ `%APPDATA%\Worktabs` に置くので、インストール版と zip 版は同時には起動できません（後から起動した方は終わり、先に起動していた方のウィンドウが前に出ます）。

## macOS の zip

- 展開した `Worktabs.app` を「アプリケーション」フォルダに移して起動します。インストーラーはありません。
- macOS の通知のために、アプリはアドホック署名をしています。Developer ID の署名も公証もしていないので、ブラウザでダウンロードした zip から出したアプリは、Gatekeeper に止められて起動できません。初回の起動の前に、ダウンロードの印（quarantine 属性）を外します。
  ```sh
  xattr -dr com.apple.quarantine /Applications/Worktabs.app
  ```
  - `gh release download` や `curl` で取ったものには印が付かないので、これは要りません。
- Apple Silicon 向けです。Intel Mac では、ソースからビルドします（下記「ソースからビルドする」）。
- 設定ファイルは `~/Library/Application Support/Worktabs/config.json` です。code-server・拡張・開いていたタブも同じフォルダに置きます。
- WSL のタブは使えません（Windows のみ）。

## アプリのアイコン

Worktabs は、重なった 3 つのエディタのウィンドウを描いた、青と紫のマークを使います。アプリの起動中は、macOS の Dock のアイコンと Windows のウィンドウのアイコンが、VS Code のテーマとは関係なく、OS のライト／ダークに合わせて変わります。Windows では、別に設定できるアプリのモードではなく、システムの外観（Windows のモード）に従います。

実行ファイル、インストーラー、macOS の Finder のアイコン、Windows のショートカットは、ダークの版を使います。Windows のタスクバーにピン留めしたものも、その版のままのことがあります。

## 新しい版に上げる

- インストーラー版は、Worktabs を終了してから、新しい版のインストーラーを実行します。前の版と入れ替わります。
- zip 版は、Worktabs を終了してから、フォルダの中身を消し、新しい版の zip を展開します。上書きで展開すると、前の版にしかないファイルが残るためです（補助拡張は `resources\native` にある VSIX を全部入れるので、古い版の VSIX が残ると古い版も入ります）。
- どちらも、設定とデータ（`%APPDATA%\Worktabs`）は残り、開いていたタブもそのまま戻ります。
- macOS は、Worktabs を終了してから、`/Applications/Worktabs.app` を新しい版のものと入れ替え、もう一度 `xattr` で印を外します（上記「macOS の zip」）。設定とデータ（`~/Library/Application Support/Worktabs`）は残ります。

## ソースからビルドする

Windows では、次のとおりです。

```sh
npm install
node node_modules/electron/install.js   # Electron 44 は本体を初回にダウンロードする
npm run pack          # dist/win-unpacked/Worktabs.exe を作る
npm run try           # それを確認用のデータで起動する（下記「自分でビルドした Worktabs を更新する」）
npm run dist:packed   # 確認した dist/win-unpacked から、dist/Worktabs-0.1.0-setup.exe（インストーラー）と dist/Worktabs-0.1.0-win.zip を作る
```

macOS では、次のとおりです。

```sh
npm install
node node_modules/electron/install.js
npm run pack:mac      # dist/mac-arm64/Worktabs.app を作る
npm run dist:mac      # dist/Worktabs-<版>-arm64-mac.zip を作る
```

- `npm run pack` は、先に `npm run build:native` で `native/claude-wrap.exe` と補助拡張の VSIX を作ります。Windows 付属の csc.exe と tar.exe を使います。
- macOS の `npm run build:native` は、補助拡張の VSIX だけを作ります。claude のラッパーは JavaScript で、アプリが起動時に `~/Library/Application Support/Worktabs/bin/` に書き出します（[architecture.md](architecture.md#claude-のラッパー)）。
- macOS のビルドは Apple Silicon 向けです。Intel Mac で作るときは `npx electron-builder --mac --x64` を使います。
- macOS のビルドは、アドホック署名（`mac.identity: "-"`）をします。署名の証明書は要りません。Electron の macOS の通知の API は、アプリのバンドルが署名されていることを求めるので、`identity: null` で署名を飛ばすと、通知が出なくなります。自分のマシンで作ったものは、ダウンロードの印が付かないので、そのまま起動できます。
- `npm run pack` はインストーラーと zip を作らないので、`npm run dist` より数分早く終わります。
- `npm run dist:packed` は作り直さず、`dist/win-unpacked` をそのまま固めます。インストーラーと zip の中身は、動作確認したものと同じです。
- 確認を挟まずに全部作るときは `npm run dist`（`pack` と `dist:packed` を続けて実行）です。
- `dist/win-unpacked/Worktabs.exe` を起動したままだと、`npm run pack` はファイルを上書きできずに失敗します。確認用を閉じてから実行してください。

## 自分でビルドした Worktabs を更新する

普段使う Worktabs は、`dist` の外のフォルダ（ここでは `C:\Tools\worktabs`）に置きます。`dist\win-unpacked` から起動して使っていると、次の `npm run pack` がファイルを上書きできません。

ビルドのたびに、次の順で更新します。

1. リポジトリのフォルダで `npm run pack` を実行し、`dist\win-unpacked` に新しいビルドを作ります。普段使いの Worktabs は起動したままで構いません。
2. （任意）`npm run try` で、新しいビルドを普段使いと並べて起動し、動作を確認します。確認が終わったら閉じます。
   - データは `%LOCALAPPDATA%\Worktabs-try` に置きます。タブ・code-server・拡張は普段使いと別なので、同時に起動できます。初回だけ、code-server と拡張（約 300 MB）をダウンロードします。
   - 設定ファイルも `%LOCALAPPDATA%\Worktabs-try\config.json` で、普段使いとは別です。
3. 普段使いの Worktabs を終了します。中の VS Code、ターミナル、Claude の会話も一緒に終わるので、作業中のものがないときに行います。
4. エクスプローラーで、リポジトリのフォルダにある `update-worktabs.cmd` をダブルクリックします。`dist\win-unpacked` の中身をまるごと `C:\Tools\worktabs` に写し、`C:\Tools\worktabs\Worktabs.exe` を起動します。開いていたタブと設定は `%APPDATA%\Worktabs` から引き継がれます。
   - Worktabs がまだ起動していると、終了するまで待ちます。起動中のものが `C:\Tools\worktabs` の外（`dist\win-unpacked` など）にあっても、普段使いのデータを使っていれば待ちます。そのまま起動すると、二重起動の防止で新しい方が終わってしまうためです。
   - 失敗したときは、ウィンドウが閉じずに理由を表示します。
   - 写し先を変えるときは、`update-worktabs.cmd` の `DEST` を書き換えます。

`update-worktabs.cmd` がしていることは、次のとおりです。

- `Worktabs.exe` だけでなく、`dist\win-unpacked` の中身を全部写します。アプリのコードは `resources\app.asar` に、Claude のラッパーと補助拡張は `resources\native` に入っています。
- robocopy の `/MIR` で写すので、写し先にしかないファイルは消えます。補助拡張は `resources\native` にある VSIX を全部入れるので、古い版の VSIX を残さないためです。
  - 写し先が空でなく、`Worktabs.exe` もないときは、別のフォルダを消さないように止まります。
  - 設定とデータは `%APPDATA%\Worktabs` にあるので、`C:\Tools\worktabs` の中身が消えても失われません。
