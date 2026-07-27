# Personal Hub

一个本地优先的个人工作台项目。当前按版本目录管理，方便后续逐步演进。

## 目录

- `versions/original/`：原始 HTML 归档，不直接修改。
- `versions/v1-local-first/`：第一版和第二版的结合版，可静态部署，本机 IndexedDB 存储。
- `site/`：当前推荐发布目录，内容由 `versions/v1-local-first/` 同步而来。

## 当前路线

v1-local-first 的目标：

- 可以直接放到 GitHub Pages、Cloudflare Pages、Netlify 或 Vercel。
- 不需要云服务器。
- 每个用户的数据保存在自己的设备浏览器里。
- 旧版 `localStorage` 数据会自动迁移到 `IndexedDB`。
- 图片和附件仍在用户当前设备中，不上传到任何云端。
- 支持主题切换；“默认（原始）”是不设置主题时的最初样式，旧版误设为暖白的记录会自动迁回默认。
- 支持在部分浏览器中选择本机备份文件夹；不支持时使用下载备份。
- 新上传附件使用 IndexedDB Blob 存储，主数据只保存文件引用。
- 备份文件会打包引用到的 Blob 附件，换设备导入时可恢复。
- 近距离同步实验版使用 WebRTC 点对点传输，支持压缩配对码、本地二维码、摄像头扫码识别和复制/粘贴兜底。

## 部署建议

把 `site/` 作为静态站点根目录部署即可。

如果用 GitHub Pages，可以把 `site/` 目录内容放到仓库根目录，或在 GitHub Pages 设置中选择对应发布分支。

## 验证

自动化验证脚本在 `test-tools/` 中，浏览器依赖放在 F 盘项目目录下。运行：

```bash
cd test-tools
npm run scan
npm run verify
npm run audit
npm run verify:sync
```

更多体验优化记录见 `OPTIMIZATION_NOTES.md`。

## 限制

- 不支持自动云同步。
- 换设备需要后续增加导出/导入或近距离同步。
- 清除浏览器站点数据会删除本机数据。
- 不同浏览器之间的数据互不共享。
