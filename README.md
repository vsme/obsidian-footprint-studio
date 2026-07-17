# Footprint Studio

在 Obsidian 内可视化创建和编辑本站的足迹 Markdown。

## 功能

- 在上方 Leaflet 地图点选坐标、搜索地点或使用当前位置。
- 根据地图坐标补全乡镇、街道和具体地点，不覆盖已经填写的城市。
- 一次导入多张图片，预览、排序并填写替代文本、说明和裁剪位置。
- 从 `blog` 目录搜索并多选关联文章，保存文章 `slug`。
- 新建时把图片写入 `attachment/footprints/<足迹文件名>`，Markdown 写入 `footprints`。
- 在任意已有足迹 Markdown 上执行“编辑当前足迹”即可重新进入表单。

## 使用

1. 在 Obsidian 的第三方插件设置中重新加载并启用 **Footprint Studio**。
2. 点击左侧地图图标新建足迹；当前打开的是足迹 Markdown 时，同一个按钮会直接进入编辑。
3. 点选地图、填写信息、导入图片，然后保存。
4. 编辑已有记录也可以在文件列表中右键 Markdown，选择“使用 Footprint Studio 编辑”。

默认目录可在插件设置页中修改。

## 开发

```bash
pnpm install
pnpm run build
```

`main.js` 已随插件生成，正常使用不需要安装开发依赖。
