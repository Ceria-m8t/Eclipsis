# Observatory Ridge（星域图谱）—— 打包好的副本

来源：https://github.com/Eridanus-Multiverse/Observatory-Ridge （MIT，见 LICENSE，原样保留）。
2026-11-13 取 main，`npm run build:lib` 打出来的 `observatory-ridge.js` + `types/`。

我们改了的地方都在 `eclipsis.patch`（只动了 NearFocus3D.tsx）：
- 渲染分辨率 `dpr` 从 [1.5, 3] 降到 [1, 2]（手机上省电、不烫，肉眼看不出）
- 界面上的几句英文换成中文

重打：在 Observatory-Ridge 源码目录 `patch -p0 < eclipsis.patch`（或手改那几行），`npm ci && npm run build:lib`，把 dist/ 拷回来。
依赖（我们 package.json 里装的）：react 18、react-dom 18、three 0.168、@react-three/fiber 8、@react-three/drei 9。
