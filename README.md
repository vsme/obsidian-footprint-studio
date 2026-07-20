# Footprint Studio

Footprint Studio is an Obsidian community plugin for creating and editing travel footprint notes with an interactive map, photos, and structured frontmatter.

https://github.com/user-attachments/assets/5e18d479-8beb-4297-b91f-f25a9e1601a1

## Features

- View all footprint notes on one map, including distinct markers for drafts.
- Create or edit a footprint through a dedicated form instead of editing frontmatter by hand.
- Import, reorder, caption, hide, and preview multiple photos.
- Read GPS coordinates and capture times from supported photo EXIF metadata.
- Search for places, reverse-geocode coordinates, and store structured address fields.
- Link footprint notes to Markdown or MDX posts in a configurable folder.
- Keep each footprint's images together in a dedicated attachment folder.
- Use the editor on desktop and mobile Obsidian.

The plugin interface is currently available in Simplified Chinese.

## Installation

### From Obsidian

Once the plugin is accepted into the community plugin directory:

1. Open **Settings → Community plugins**.
2. Select **Browse** and search for **Footprint Studio**.
3. Select **Install**, then **Enable**.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release.
2. Create `<vault>/.obsidian/plugins/footprint-studio/`.
3. Copy the three files into that folder.
4. Reload Obsidian and enable **Footprint Studio** under **Community plugins**.

## Usage

1. Select the map pin in the ribbon to open the footprint overview.
2. Create a footprint, choose a location, complete the form, and add at least one photo.
3. Select **保存足迹** to save the note and its managed attachments.
4. To edit an existing note, use its file-menu action **使用 Footprint Studio 编辑**.

The default folders are:

- Footprint notes: `footprints`
- Managed photos: `attachment/footprints/<footprint-name>`
- Related posts: `blog`

All three paths, the map defaults, and the tile URL can be changed in the plugin settings. The command **保存当前足迹** has no default hotkey; assign one in **Settings → Hotkeys** if desired.

## Data and network access

Footprint Studio stores settings through Obsidian and only modifies files in the configured vault folders. Removing a managed photo from a footprint may move that photo to the system trash when the footprint is saved.

The plugin makes direct network requests for its map features:

- Map tiles are loaded from the configured tile server. The default is OpenStreetMap's standard tile service.
- Place search and reverse geocoding use the public Nominatim service at `nominatim.openstreetmap.org`.
- Search text or selected coordinates are sent to Nominatim. Map tile requests disclose the requested map area and normal connection metadata to the tile provider.

No analytics or telemetry are collected by this plugin. Review the [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/) and [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) before heavy use.

## Development

Requirements: Node.js 20 or newer and pnpm 10.

```bash
pnpm install
pnpm run dev
```

Run a production build and type check with:

```bash
pnpm run build
```

The build creates `main.js` locally. Compiled files are attached to GitHub releases and are intentionally not tracked in the source repository.

## Releasing

1. Update `minAppVersion` in `manifest.json` if needed.
2. Run `pnpm version patch`, `pnpm version minor`, or `pnpm version major`.
3. Commit and push the version change.
4. Push a tag matching the version exactly, without a `v` prefix (for example, `0.6.1`).
5. Review and publish the draft GitHub release created by the release workflow.

The release must contain `main.js`, `manifest.json`, and `styles.css`.

## License

[MIT](LICENSE)
