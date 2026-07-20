# Footprint Studio

[English](README.md) | [简体中文](README-zh.md)

Footprint Studio 是一款 Obsidian 社区插件，帮助你用地图和照片记录旅途，并通过表单轻松创建、编辑结构化的足迹笔记。

https://github.com/user-attachments/assets/5e18d479-8beb-4297-b91f-f25a9e1601a1

## 功能特性

- 在地图上集中浏览所有足迹，并用不同的标记区分草稿。
- 通过表单创建和编辑足迹，不必手动填写 frontmatter。
- 一次导入多张照片，还可调整顺序、添加说明、隐藏或预览照片。
- 自动读取照片 EXIF 信息中的 GPS 坐标和拍摄时间（需照片本身包含相关信息）。
- 支持地点搜索和坐标反查，并将地址按省、市、区等字段保存。
- 可将足迹关联到指定目录下的 Markdown 或 MDX 文章。
- 每条足迹的照片都会整理到单独的附件文件夹中。
- 桌面端和移动端 Obsidian 均可使用。

插件界面目前提供简体中文。

## 安装

### 从 Obsidian 安装

插件上架 Obsidian 社区插件市场后，可以按以下步骤安装：

1. 打开 **设置 → 第三方插件**。
2. 点击 **浏览**，搜索 `Footprint Studio`。
3. 点击 **安装**，然后点击 **启用**。

### 手动安装

1. 在最新的 GitHub Release 中下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 在你的 Obsidian 仓库中创建 `.obsidian/plugins/footprint-studio/` 文件夹。
3. 将下载的三个文件放入该文件夹。
4. 重新加载 Obsidian，然后在 **第三方插件** 中启用 `Footprint Studio`。

## 使用方法

1. 点击左侧边栏中的地图图钉图标，打开足迹总览。
2. 新建足迹，选择地点、填写内容，并添加至少一张照片。
3. 点击 **保存足迹**，插件会同时保存笔记和相关照片。
4. 要修改已有足迹，可以在对应笔记的文件菜单中选择 **使用 Footprint Studio 编辑**。

默认目录如下：

- 足迹笔记：`footprints`
- 足迹照片：`attachment/footprints/<足迹名称>`
- 关联文章：`blog`

以上三个目录，以及地图的默认位置、缩放级别和瓦片地址，都可以在插件设置中修改。**保存当前足迹** 命令默认没有快捷键，如有需要，可以前往 **设置 → 快捷键** 自行设置。

## 数据与网络访问

Footprint Studio 使用 Obsidian 自带的机制保存插件设置，只会修改仓库内指定目录中的文件。保存足迹时，如果移除了之前导入的照片，插件可能会将对应文件移到系统废纸篓。

使用地图相关功能时，插件会发起以下网络请求：

- 地图画面从设置中指定的瓦片服务器加载，默认使用 OpenStreetMap 标准瓦片服务。
- 地点搜索和坐标反查使用 `nominatim.openstreetmap.org` 提供的公共 Nominatim 服务。
- 搜索关键词或选中的坐标会发送给 Nominatim；加载地图时，瓦片服务商也会收到当前查看区域及常规的网络连接信息。

本插件不会收集统计或遥测数据。如果需要频繁使用地图与地点搜索功能，请先了解 [OpenStreetMap 瓦片使用政策](https://operations.osmfoundation.org/policies/tiles/)和 [Nominatim 使用政策](https://operations.osmfoundation.org/policies/nominatim/)。

## 开发

环境要求：Node.js 20 或更高版本，以及 pnpm 10。

```bash
pnpm install
pnpm run dev
```

执行类型检查并生成生产版本：

```bash
pnpm run build
```

构建完成后会在本地生成 `main.js`。该文件会随 GitHub Release 发布，不纳入源代码版本控制。

## 发布

先确认所有改动都已提交到 `main` 分支，再运行以下任一命令：

```bash
npm run release -- patch
npm run release -- minor
npm run release -- major
```

发布脚本会先确认本地 `main` 与 `origin/main` 保持一致，然后执行生产构建、更新 `package.json`、`manifest.json` 和 `versions.json`，创建发布提交与版本标签，并推送到 GitHub。版本标签推送后，GitHub Actions 会自动创建对应的 Release。

也可以使用 `npm run release -- 1.2.3` 发布指定版本。如果最低兼容的 Obsidian 版本有变化，请先修改并提交 `manifest.json` 中的 `minAppVersion`，再运行发布命令。

发布包必须包含 `main.js`、`manifest.json` 和 `styles.css`。

## 许可证

[MIT](LICENSE)
