# Personal Hub v1-local-first

这是可免费静态上线的本地优先版本。

## 特性

- 单页 HTML 应用，打开 `index.html` 即可使用。
- 支持 GitHub Pages / Cloudflare Pages / Netlify / Vercel 静态托管。
- 使用 IndexedDB 保存工作台数据，包含图片和附件的 base64 数据。
- 首次打开时会尝试把旧版 `localStorage` 数据迁移到 IndexedDB。
- 保留 JSON 导入/导出，方便备份和手动迁移。

## 使用方式

本地打开：

```text
index.html
```

静态部署：

```text
把本目录作为站点根目录
```

## 数据说明

所有数据保存在用户当前浏览器的本机站点数据中。项目没有账号系统，也不会把数据上传到服务器。

清除浏览器数据、换浏览器或换设备都会导致看不到原数据。请使用导出功能备份。
