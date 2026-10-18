# リリース

[English](../releasing.md) | **日本語**

版のタグを push すると、GitHub Actions（`.github/workflows/release.yml`）がタグのコミットから Windows のインストーラーと zip、macOS の zip を作り、GitHub Releases に出します。誰がどのコードから作ったものかが分かるように、配るものはローカルでは作りません。

コミットの接頭辞の決まりは [CONTRIBUTING.md](../../.github/CONTRIBUTING.md)（英語）にあります。リリースノートは、その接頭辞から作ります。

## 版の付け方

- [SemVer](https://semver.org/lang/ja/) で付けます。`0.x` の間は互換性を保証しません（設定ファイルやデータフォルダの中身が変わることがあります）。
- どこを上げるかは、そのリリースに入るコミットの接頭辞で決めます（[CONTRIBUTING.md](../../.github/CONTRIBUTING.md)（英語）の「1. Prefixes」）。`feat:` があれば minor、`fix:` などだけなら patch です。
- 版を書くのは `package.json` の `version` だけです。アプリが名乗る版、インストーラーと zip（Windows と macOS）の名前、タグは、ここからそろいます。
- 補助拡張の版（`helper-extension/package.json`）はこれとは別で、補助拡張の中身を変えたときに上げます。アプリは補助拡張の版で、各タブの VS Code に入れ直すかを決めるためです。

## リリースする

main は PR を通した変更しか受け付けないので、リリースのコミットも PR を通し、マージしてから main にタグを付けます。

1. main を最新にします。
   ```sh
   git switch main
   git pull
   npm ci
   npm run changelog   # （任意）まだリリースしていない分を見る
   npm run pack        # （任意）main のビルドを npm run try で確かめる（install.md の「自分でビルドした Worktabs を更新する」）
   ```
2. ブランチで版を上げます。
   ```sh
   git switch -c release/v0.6.0
   npm version minor   # 0.5.0 → 0.6.0。修正だけなら patch
   git commit -am "chore(release): v0.6.0"
   ```
   `npm version` は、`package.json` と `package-lock.json` の `version` を上げ、`CHANGELOG.md` を git-cliff で作り直します（`scripts/changelog.js`。設定は `cliff.toml`）。コミットもタグも作りません（`.npmrc`）。作業ツリーも確かめないので、変更のない状態から始めます。`git commit -am` は、変更をすべてコミットするためです。
3. そのタイトルで PR を作り、チェックが通ったら squash merge します。`cliff.toml` は、`chore(release)` のタイトルを `CHANGELOG.md` に入れません。タグを push するまで、ほかの PR はマージしません。タグを付けるコミットの CHANGELOG が、そのコミットの中身と合うようにするためです。
   ```sh
   git push -u origin release/v0.6.0
   gh pr create --fill
   gh pr merge --squash --delete-branch   # チェックが通ってから
   ```
4. main のマージしたコミットにタグを付けて、タグを push します。
   ```sh
   git switch main
   git pull
   git tag v0.6.0
   git push origin v0.6.0
   ```
5. Actions の「Release」が終わると、Releases に出ます。タグを push したらすぐに配られるので、確かめることは手順 1 で済ませておきます。

- リポジトリは公開のときに 1 つのコミットから始め直したので、CHANGELOG とタグもそこから始まります。0.4.0 までの版は公開していません。
- `CHANGELOG.md` は、リリースのたびにすべての履歴から作り直すので、手で直しても次のリリースで消えます。直すのは、コミットのメッセージ（squash merge では PR のタイトル）の方です。

## Release のワークフローがすること

`v` で始まるタグの push で動きます。

- タグと `package.json` の版が違うときは、ビルドせずに失敗します。アプリは `package.json` の版を名乗るためです。
- リリースノートは、タグのコミットの `CHANGELOG.md` から、その版の節を取り出したものです（`scripts/release-notes.js`）。ワークフローでは git-cliff を実行しないので、CHANGELOG とリリースノートは食い違いません。節がないときは、ビルドの前に失敗します。末尾に、どのファイルを取ればいいかの表を足します。
- ビルドは、Windows（`npm run dist`）と macOS（`npm run dist:mac`）の 2 つのジョブで並べて行います。どちらも、ビルドの前に `npm run check` と `npm test` を実行します。片方が失敗すると、もう片方も止め、リリースは作りません。
- できたファイルは、最後のジョブが 1 つにまとめて、1 つのリリースに出します。
- `SHA256SUMS.txt`（インストーラーと 2 つの zip の SHA-256）も一緒に出します。リポジトリが公開なら、Artifact attestation（どのコミットから作ったかの証明）も付けます。非公開のリポジトリでは使えないので飛ばします。
- `-` を含む版（`0.2.0-rc.1` など）は、プレリリースとして出します。

リリースノートは、手元でも同じものを見られます。

```sh
node scripts/release-notes.js v0.2.0
```

ワークフローはタグでしか動きません。`scripts/release-notes.js` と `cliff.toml` は、`npm test`（`test/release-notes.test.js`）で確かめます。

## 失敗したとき

- ワークフローが途中で失敗したときは、原因を取り除いてから、Actions で Re-run します。gh はファイルをすべて上げ終えてからリリースを公開し、上げるのに失敗したら途中のリリースを消すので、そのまま作り直せます。
- ビルドやテストが失敗して、コードを直す必要があるときは、タグを消し、直す PR をマージしてから、同じ版をもう一度リリースします。「リリースする」の手順 2〜4 を、`npm version 0.6.0 --allow-same-version` で行います。CHANGELOG に直した分も入れるためです。
  ```sh
  git push origin :refs/tags/v0.6.0
  git tag -d v0.6.0
  ```
- 出したあとで問題が見つかったときは、直して次の patch を出します。出した版のタグは付け直しません。配ったものと、タグのコードが食い違うためです。

## 署名

リリースノートで Codex への対応を完了と書く前に、[検証の表](codex-verification.md)を、出すアプリと拡張の版で更新します。確かめた環境と、残っている制限を書きます。サインインしたプラットフォームでの確認が残っている間は、その表のリリースノートの範囲に沿って書きます。

インストーラーと `Worktabs.exe` は署名していないので、ダウンロードしたものは初回の起動で SmartScreen の警告が出ます。macOS の `Worktabs.app` は、Electron が通知を出せるように、アドホック署名をしています。Developer ID の署名も公証もしていないので、ダウンロードしたものは、やはり Gatekeeper に止められます。起動する前に `xattr` でダウンロードの印を外します（[install.md](install.md#macos-の-zip)）。
