# 翻頁書

喺瀏覽器入面把 PDF 當書睇：寬螢幕左右兩頁，手機就一頁一頁揭。檔案只會留喺你部裝置，唔會上傳。

A static flipbook. You pick a PDF on your own phone or computer and turn the pages in the browser. The file is never uploaded.

## 點用

1. 打開網站。
2. 撳「揀 PDF 檔」，或者喺電腦將 PDF 拖入去。都可以撳「試睇範例」先試翻頁。
3. 揭頁：撳頁面邊緣、左右滑，或者用鍵盤左右方向鍵。
4. 底部可以去第一頁、上一頁、下一頁、最後一頁，撳頁碼就可以跳去第幾頁。
5. 「放大」「縮細」用來睇清楚。放大之後可以拖住畫面移動；手機亦可以用兩指放大。
6. 「全螢幕」會鋪滿畫面。「開另一本」可以換一份 PDF。

## 發佈

呢個係純靜態網站，放喺 `main` 分支嘅根目錄就得。擁有人之後可以喺 GitHub 倉庫設定開 Pages（Branch：`main`，資料夾：`/ (root)`），網址會係：

https://tradingservant.github.io/eriflipbook/

唔好直接用檔案總管打開 `index.html`（`file://`）。PDF 元件要用網頁伺服器先載入到。本地可以喺專案資料夾執行：

```bash
python3 -m http.server 8765
```

然後打開 http://localhost:8765/ 。

## 私隱

PDF 只用瀏覽器嘅本機檔案讀取，唔會送到任何伺服器，倉庫入面亦冇任何書本內容。

## 用到嘅程式庫

- [PDF.js](https://github.com/mozilla/pdf.js) 4.10.38（Apache-2.0）— 將 PDF 畫成圖
- [StPageFlip](https://github.com/Nodlik/StPageFlip) / `page-flip` 2.0.7（MIT）— 翻頁效果

檔案放喺 `vendor/`。授權同小改動註明喺 `vendor/VERSIONS.txt` 同 `vendor/page-flip/PATCHES.md`。
