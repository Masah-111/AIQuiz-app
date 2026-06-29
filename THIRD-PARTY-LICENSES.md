# Third-Party Licenses / 同梱・利用しているソフトウェアのライセンス

This project (`ai_quiz_app_v5.html`) is released under the MIT License (see `LICENSE`).
本体は MIT ライセンスで公開しています（`LICENSE` を参照）。

In addition, it bundles or uses the following third-party software. Their licenses are
reproduced/linked below and are retained as required.
本体は以下のサードパーティ製ソフトウェアを同梱・利用しています。各ライセンスを下記のとおり保持します。

---

## KaTeX (bundled / 同梱)

Fast math typesetting for the web. The CSS, JavaScript, and woff2 fonts are inlined into
`ai_quiz_app_v5.html` for fully offline rendering.
数式表示ライブラリ。CSS・JavaScript・woff2 フォントを HTML にインライン同梱しています。

- Project: https://katex.org / https://github.com/KaTeX/KaTeX
- License: **MIT License**
- Copyright (c) 2013-2020 Khan Academy and other contributors
- Full text: https://github.com/KaTeX/KaTeX/blob/main/LICENSE

```
MIT License

Copyright (c) 2013-2020 Khan Academy and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### KaTeX fonts (KaTeX_* woff2, bundled / 同梱)

- License: **SIL Open Font License, Version 1.1**
- Full text: https://github.com/KaTeX/KaTeX/blob/main/src/fonts/OFL.txt

---

## pdf.js (loaded from CDN / CDN から読み込み、同梱せず)

Used to render the cited page of uploaded PDFs (source view and figure cropping).
Loaded at runtime from a CDN; **not bundled** in this repository.
アップロードした PDF の該当ページ描画（出典表示・図の切り出し）に使用。実行時に CDN から
読み込んでおり、本リポジトリには**同梱していません**。

- Project: https://github.com/mozilla/pdf.js
- License: **Apache License 2.0**
- Full text: https://github.com/mozilla/pdf.js/blob/master/LICENSE
- CDN: https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/
