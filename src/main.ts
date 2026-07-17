import {
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath,
  requestUrl,
  setIcon,
} from "obsidian";
import * as L from "leaflet";

const VIEW_TYPE = "footprint-studio-view";

interface FootprintStudioSettings {
  footprintsFolder: string;
  attachmentsFolder: string;
  blogFolder: string;
  tileUrl: string;
  defaultLat: number;
  defaultLng: number;
  defaultZoom: number;
}

const DEFAULT_SETTINGS: FootprintStudioSettings = {
  footprintsFolder: "footprints",
  attachmentsFolder: "attachment/footprints",
  blogFolder: "blog",
  tileUrl: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  defaultLat: 35.8617,
  defaultLng: 104.1954,
  defaultZoom: 4,
};

interface PhotoDraft {
  id: string;
  file?: File;
  source?: string;
  previewUrl: string;
  alt: string;
  caption: string;
  position: string;
}

interface BlogPostOption {
  id: string;
  title: string;
  path: string;
}

interface NominatimAddress {
  country?: string;
  state?: string;
  province?: string;
  city?: string;
  town?: string;
  municipality?: string;
  county?: string;
  village?: string;
  suburb?: string;
  neighbourhood?: string;
  quarter?: string;
  hamlet?: string;
  road?: string;
  house_number?: string;
  tourism?: string;
  amenity?: string;
  historic?: string;
}

interface NominatimResult {
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
  address?: NominatimAddress;
}

type FieldName =
  | "fileName"
  | "visitedAt"
  | "country"
  | "region"
  | "city"
  | "place"
  | "lat"
  | "lng"
  | "description";

function todayString(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function dateString(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim();
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? todayString();
}

function yamlString(value: string): string {
  return JSON.stringify(value ?? "");
}

function baseName(path: string): string {
  return path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? path;
}

function extensionOf(name: string): string {
  const match = name.match(/\.([a-zA-Z0-9]+)$/);
  return match ? `.${match[1].toLowerCase()}` : "";
}

function sanitizeSegment(value: string, fallback = "footprint"): string {
  const safe = value
    .normalize("NFKC")
    .trim()
    .replace(/[\\/:*?\"<>|#^\[\]]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return safe || fallback;
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n)?/, "").trim();
}

function relativePath(fromFile: string, toFile: string): string {
  const from = normalizePath(fromFile).split("/");
  from.pop();
  const to = normalizePath(toFile).split("/");
  while (from.length && to.length && from[0] === to[0]) {
    from.shift();
    to.shift();
  }
  return [...from.map(() => ".."), ...to].join("/") || ".";
}

function makeButton(
  parent: HTMLElement,
  label: string,
  icon?: string,
  className?: string
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className ?? "";
  if (icon) {
    const iconEl = document.createElement("span");
    iconEl.className = "footprint-studio-button-icon";
    setIcon(iconEl, icon);
    button.append(iconEl);
  }
  const text = document.createElement("span");
  text.textContent = label;
  button.append(text);
  parent.append(button);
  return button;
}

export default class FootprintStudioPlugin extends Plugin {
  settings: FootprintStudioSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.registerView(VIEW_TYPE, leaf => new FootprintStudioView(leaf, this));
    this.addRibbonIcon("map-pinned", "新建或编辑足迹", () => {
      const activeFile = this.app.workspace.getActiveFile();
      void this.openStudio(this.isFootprintFile(activeFile) ? activeFile : undefined);
    });

    this.addCommand({
      id: "create-footprint",
      name: "新建足迹",
      callback: () => this.openStudio(),
    });

    this.addCommand({
      id: "edit-current-footprint",
      name: "编辑当前足迹",
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        const prefix = `${normalizePath(this.settings.footprintsFolder)}/`;
        const canEdit = file instanceof TFile && file.path.startsWith(prefix);
        if (!checking && canEdit) void this.openStudio(file);
        return canEdit;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!this.isFootprintFile(file)) return;
        menu.addItem(item =>
          item
            .setTitle("使用 Footprint Studio 编辑")
            .setIcon("map-pinned")
            .onClick(() => this.openStudio(file))
        );
      })
    );

    this.addSettingTab(new FootprintStudioSettingTab(this.app, this));
  }

  async onunload(): Promise<void> {
    await Promise.all(
      this.app.workspace.getLeavesOfType(VIEW_TYPE).map(leaf => leaf.detach())
    );
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private isFootprintFile(file: unknown): file is TFile {
    const prefix = `${normalizePath(this.settings.footprintsFolder)}/`;
    return file instanceof TFile && file.path.startsWith(prefix);
  }

  async openStudio(file?: TFile): Promise<void> {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof FootprintStudioView) await view.openFile(file ?? null);
  }
}

class FootprintStudioView extends ItemView {
  private plugin: FootprintStudioPlugin;
  private map: L.Map | null = null;
  private marker: L.Marker | null = null;
  private currentFile: TFile | null = null;
  private photos: PhotoDraft[] = [];
  private blogPosts: BlogPostOption[] = [];
  private selectedPosts = new Set<string>();
  private fields = {} as Record<FieldName, HTMLInputElement | HTMLTextAreaElement>;
  private draftInput!: HTMLInputElement;
  private photosEl!: HTMLElement;
  private postsEl!: HTMLElement;
  private selectedPostsEl!: HTMLElement;
  private postSearchInput!: HTMLInputElement;
  private searchResultsEl!: HTMLElement;
  private fileNameDirty = false;
  private saving = false;
  private draggedPhoto = -1;

  constructor(leaf: WorkspaceLeaf, plugin: FootprintStudioPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.currentFile ? `编辑足迹 · ${this.currentFile.basename}` : "新建足迹";
  }

  getIcon(): string {
    return "map-pinned";
  }

  async onOpen(): Promise<void> {
    await this.renderView();
  }

  async onClose(): Promise<void> {
    this.disposePhotos();
    this.map?.remove();
    this.map = null;
  }

  async openFile(file: TFile | null): Promise<void> {
    if (!this.fields.visitedAt) await this.renderView();
    this.resetForm();
    if (!file) return;

    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    if (!frontmatter) {
      new Notice("没有读取到这篇足迹的 frontmatter");
      return;
    }

    this.currentFile = file;
    this.fields.fileName.value = file.basename;
    this.fields.fileName.disabled = true;
    this.fields.visitedAt.value = dateString(frontmatter.visitedAt);
    this.fields.country.value = String(frontmatter.country ?? "");
    this.fields.region.value = String(frontmatter.region ?? "");
    this.fields.city.value = String(frontmatter.city ?? "");
    this.fields.place.value = String(frontmatter.place ?? "");
    this.fields.lat.value = String(frontmatter.coordinates?.lat ?? "");
    this.fields.lng.value = String(frontmatter.coordinates?.lng ?? "");
    this.draftInput.checked = Boolean(frontmatter.draft);
    this.selectedPosts = new Set(
      Array.isArray(frontmatter.relatedPosts)
        ? frontmatter.relatedPosts.map((value: unknown) => String(value))
        : []
    );

    const markdown = await this.app.vault.read(file);
    this.fields.description.value = stripFrontmatter(markdown);
    this.disposePhotos();
    this.photos = (Array.isArray(frontmatter.photos) ? frontmatter.photos : []).map(
      (photo: Record<string, unknown>, index: number) => {
        const source = String(photo.src ?? "");
        const linked = this.app.metadataCache.getFirstLinkpathDest(source, file.path);
        return {
          id: `existing-${index}-${Date.now()}`,
          source,
          previewUrl:
            linked instanceof TFile ? this.app.vault.getResourcePath(linked) : "",
          alt: String(photo.alt ?? ""),
          caption: String(photo.caption ?? ""),
          position: String(photo.position ?? ""),
        };
      }
    );

    this.renderPhotos();
    this.renderSelectedPosts();
    this.renderPostSuggestions();
    this.updateMarker(true);
    this.app.workspace.trigger("layout-change");
  }

  private async renderView(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("footprint-studio-view");

    const header = this.contentEl.createDiv({ cls: "footprint-studio-header" });
    const heading = header.createDiv({ cls: "footprint-studio-heading" });
    heading.createEl("h2", { text: "足迹编辑器" });
    heading.createEl("p", { text: "在地图上标记去向，把照片和当时的文字留在一起。" });
    const actions = header.createDiv({ cls: "footprint-studio-header-actions" });
    const resetButton = makeButton(actions, "新建", "file-plus-2");
    resetButton.addEventListener("click", () => this.resetForm());
    const saveButton = makeButton(actions, "保存足迹", "save", "mod-cta");
    saveButton.addEventListener("click", () => void this.saveFootprint(saveButton));

    const workspace = this.contentEl.createDiv({ cls: "footprint-studio-workspace" });
    const mapPanel = workspace.createDiv({ cls: "footprint-studio-map-panel" });
    this.renderMapToolbar(mapPanel);
    const mapEl = mapPanel.createDiv({ cls: "footprint-studio-map" });
    mapEl.setAttribute("aria-label", "足迹坐标选择地图");
    this.searchResultsEl = mapPanel.createDiv({
      cls: "footprint-studio-search-results",
    });
    this.searchResultsEl.hidden = true;

    const form = workspace.createDiv({ cls: "footprint-studio-form" });
    this.renderBasicFields(form);
    this.renderRelatedSection(form);
    this.renderPhotoSection(form);
    this.renderDescriptionSection(form);

    this.blogPosts = this.loadBlogPosts();
    this.resetForm();

    requestAnimationFrame(() => {
      this.map?.remove();
      this.map = L.map(mapEl, {
        zoomControl: true,
        scrollWheelZoom: true,
        attributionControl: true,
      }).setView(
        [this.plugin.settings.defaultLat, this.plugin.settings.defaultLng],
        this.plugin.settings.defaultZoom
      );
      L.tileLayer(this.plugin.settings.tileUrl, {
        maxZoom: 19,
        attribution: "© OpenStreetMap contributors",
      }).addTo(this.map);
      this.map.on("click", event => {
        this.setCoordinates(event.latlng.lat, event.latlng.lng, false);
      });
      setTimeout(() => this.map?.invalidateSize(), 0);
    });
  }

  private renderMapToolbar(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: "footprint-studio-map-toolbar" });
    const searchInput = toolbar.createEl("input", {
      type: "search",
      placeholder: "搜索城市或景点",
      attr: { "aria-label": "搜索地图地点" },
    });
    const searchButton = makeButton(toolbar, "搜索", "search");
    const locateButton = makeButton(toolbar, "当前位置", "locate-fixed");
    const reverseButton = makeButton(toolbar, "补全地点", "map-pin-check");

    const runSearch = () => void this.searchPlace(searchInput.value);
    searchButton.addEventListener("click", runSearch);
    searchInput.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch();
      }
    });
    locateButton.addEventListener("click", () => this.locateUser());
    reverseButton.addEventListener("click", () => void this.reverseGeocode());
  }

  private renderBasicFields(parent: HTMLElement): void {
    const section = this.createSection(parent, "基础信息", "map-pin");
    const grid = section.createDiv({ cls: "footprint-studio-field-grid" });
    this.fields.fileName = this.createInput(grid, "文件名", "fileName", "例如 2026-07-17-panmen");
    this.fields.visitedAt = this.createInput(grid, "日期", "visitedAt", "", "date");
    this.fields.country = this.createInput(grid, "国家", "country", "中国");
    this.fields.region = this.createInput(grid, "省 / 地区", "region", "江苏");
    this.fields.city = this.createInput(grid, "城市", "city", "苏州");
    this.fields.place = this.createInput(grid, "地点", "place", "盘门");
    this.fields.lat = this.createInput(grid, "纬度", "lat", "31.2883", "number");
    this.fields.lng = this.createInput(grid, "经度", "lng", "120.6183", "number");
    this.fields.lat.setAttribute("step", "any");
    this.fields.lng.setAttribute("step", "any");

    this.fields.fileName.addEventListener("input", () => (this.fileNameDirty = true));
    for (const name of ["visitedAt", "city", "place"] as FieldName[]) {
      this.fields[name].addEventListener("input", () => this.updateSuggestedFileName());
    }
    for (const name of ["lat", "lng"] as FieldName[]) {
      this.fields[name].addEventListener("change", () => this.updateMarker(false));
    }

    const draftLabel = section.createEl("label", { cls: "footprint-studio-toggle" });
    this.draftInput = draftLabel.createEl("input", { type: "checkbox" });
    draftLabel.createSpan({ text: "保存为草稿（网站不会展示）" });
  }

  private renderRelatedSection(parent: HTMLElement): void {
    const section = this.createSection(parent, "关联文章", "link-2");
    const control = section.createDiv({ cls: "footprint-studio-related-control" });
    this.selectedPostsEl = control.createDiv({ cls: "footprint-studio-selected-posts" });
    this.postSearchInput = control.createEl("input", {
      type: "search",
      placeholder: "输入标题或 slug 搜索并添加文章",
      cls: "footprint-studio-post-search",
      attr: { autocomplete: "off" },
    });
    this.postsEl = control.createDiv({ cls: "footprint-studio-post-list" });
    this.postsEl.hidden = true;
    this.postSearchInput.addEventListener("input", () => this.renderPostSuggestions());
    this.postSearchInput.addEventListener("focus", () => this.renderPostSuggestions());
    this.postSearchInput.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        this.postsEl.hidden = true;
        this.postSearchInput.blur();
      }
    });
    this.postSearchInput.addEventListener("blur", () => {
      window.setTimeout(() => (this.postsEl.hidden = true), 120);
    });
  }

  private renderPhotoSection(parent: HTMLElement): void {
    const section = this.createSection(parent, "照片", "images");
    const intro = section.createDiv({ cls: "footprint-studio-photo-intro" });
    intro.createEl("p", {
      text: "选择照片后可拖动排序；替代文本会写入 Astro 的 photos 字段。",
    });
    const picker = makeButton(intro, "选择图片", "image-plus", "mod-cta");
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    input.hidden = true;
    input.addEventListener("change", () => {
      this.addPhotoFiles(Array.from(input.files ?? []));
      input.value = "";
    });
    section.append(input);
    picker.addEventListener("click", () => input.click());
    this.photosEl = section.createDiv({ cls: "footprint-studio-photo-grid" });
  }

  private renderDescriptionSection(parent: HTMLElement): void {
    const section = this.createSection(parent, "文字记录", "text-cursor-input");
    this.fields.description = section.createEl("textarea", {
      cls: "footprint-studio-description",
      placeholder: "写下当时看到的光、天气或心情……",
      attr: { rows: "7" },
    });
  }

  private createSection(parent: HTMLElement, title: string, icon: string): HTMLElement {
    const section = parent.createEl("section", { cls: "footprint-studio-section" });
    const heading = section.createEl("h3");
    const iconEl = heading.createSpan({ cls: "footprint-studio-section-icon" });
    setIcon(iconEl, icon);
    heading.createSpan({ text: title });
    return section;
  }

  private createInput(
    parent: HTMLElement,
    label: string,
    name: FieldName,
    placeholder = "",
    type = "text"
  ): HTMLInputElement {
    const wrapper = parent.createEl("label", { cls: "footprint-studio-field" });
    wrapper.createSpan({ text: label });
    const input = wrapper.createEl("input", {
      type,
      placeholder,
      attr: { name },
    });
    return input;
  }

  private resetForm(): void {
    this.currentFile = null;
    this.disposePhotos();
    this.photos = [];
    this.selectedPosts.clear();
    this.fileNameDirty = false;
    if (!this.fields.visitedAt) return;

    for (const field of Object.values(this.fields)) field.value = "";
    this.fields.fileName.disabled = false;
    this.fields.visitedAt.value = todayString();
    this.draftInput.checked = false;
    this.postSearchInput.value = "";
    this.renderPhotos();
    this.renderSelectedPosts();
    this.renderPostSuggestions();
    this.searchResultsEl.hidden = true;
    this.marker?.remove();
    this.marker = null;
    this.map?.setView(
      [this.plugin.settings.defaultLat, this.plugin.settings.defaultLng],
      this.plugin.settings.defaultZoom
    );
    this.updateSuggestedFileName();
  }

  private updateSuggestedFileName(): void {
    if (this.currentFile || this.fileNameDirty) return;
    const place = this.fields.place.value.trim() || this.fields.city.value.trim();
    this.fields.fileName.value = sanitizeSegment(
      [this.fields.visitedAt.value || todayString(), place].filter(Boolean).join("-")
    );
  }

  private setCoordinates(lat: number, lng: number, moveMap: boolean): void {
    this.fields.lat.value = lat.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    this.fields.lng.value = lng.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    this.updateMarker(moveMap);
  }

  private updateMarker(moveMap: boolean): void {
    if (!this.map) {
      setTimeout(() => this.updateMarker(moveMap), 50);
      return;
    }
    const lat = Number(this.fields.lat.value);
    const lng = Number(this.fields.lng.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (!this.marker) {
      const icon = L.divIcon({
        className: "footprint-studio-map-pin",
        html: "<span></span>",
        iconSize: [28, 34],
        iconAnchor: [14, 32],
      });
      this.marker = L.marker([lat, lng], { icon }).addTo(this.map);
    } else {
      this.marker.setLatLng([lat, lng]);
    }
    if (moveMap) this.map.setView([lat, lng], Math.max(this.map.getZoom(), 14));
  }

  private async searchPlace(query: string): Promise<void> {
    const text = query.trim();
    if (!text) {
      new Notice("请先输入城市或景点名称");
      return;
    }
    this.searchResultsEl.hidden = false;
    this.searchResultsEl.empty();
    this.searchResultsEl.createDiv({ cls: "footprint-studio-searching", text: "正在搜索…" });
    try {
      const response = await requestUrl({
        url: `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(text)}`,
        headers: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6" },
      });
      const results = response.json as NominatimResult[];
      this.searchResultsEl.empty();
      if (!results.length) {
        this.searchResultsEl.createDiv({ text: "没有找到匹配地点" });
        return;
      }
      for (const result of results) {
        const button = this.searchResultsEl.createEl("button", {
          cls: "footprint-studio-search-result",
          attr: { type: "button" },
        });
        button.createEl("strong", { text: result.name || result.display_name.split(",")[0] });
        button.createEl("span", { text: result.display_name });
        button.addEventListener("click", () => {
          const lat = Number(result.lat);
          const lng = Number(result.lon);
          this.setCoordinates(lat, lng, true);
          this.applyAddress(result.address ?? {}, result.name);
          this.searchResultsEl.hidden = true;
        });
      }
    } catch (error) {
      console.error("Footprint Studio search failed", error);
      this.searchResultsEl.empty();
      this.searchResultsEl.createDiv({ text: "搜索失败，请检查网络后重试" });
    }
  }

  private locateUser(): void {
    if (!navigator.geolocation) {
      new Notice("当前设备不支持定位");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      position => {
        this.setCoordinates(position.coords.latitude, position.coords.longitude, true);
        void this.reverseGeocode();
      },
      () => new Notice("无法获取当前位置，请检查系统定位权限"),
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }

  private async reverseGeocode(): Promise<void> {
    const lat = Number(this.fields.lat.value);
    const lng = Number(this.fields.lng.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      new Notice("请先在地图上选择坐标");
      return;
    }
    try {
      const response = await requestUrl({
        url: `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat}&lon=${lng}`,
        headers: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6" },
      });
      const result = response.json as NominatimResult;
      this.applyAddress(result.address ?? {}, result.name);
      new Notice("已补全乡镇和具体地点，原城市保持不变");
    } catch (error) {
      console.error("Footprint Studio reverse geocoding failed", error);
      new Notice("地点反查失败，请手动填写或稍后重试");
    }
  }

  private applyAddress(address: NominatimAddress, name?: string): void {
    if (!this.fields.country.value.trim() && address.country) {
      this.fields.country.value = address.country;
    }
    if (!this.fields.region.value.trim()) {
      this.fields.region.value = address.state ?? address.province ?? "";
    }
    if (!this.fields.city.value.trim()) {
      this.fields.city.value =
        address.city ?? address.municipality ?? address.county ?? "";
    }

    const administrativeValues = new Set(
      [
        this.fields.country.value,
        this.fields.region.value,
        this.fields.city.value,
        address.city,
        address.municipality,
        address.county,
      ]
        .filter(Boolean)
        .map(value => String(value).trim())
    );
    const road = [address.road, address.house_number].filter(Boolean).join(" ");
    const placeParts = [
      address.town,
      address.village,
      address.hamlet,
      address.suburb,
      address.neighbourhood,
      address.quarter,
      name,
      address.tourism,
      address.historic,
      address.amenity,
      road,
    ]
      .map(value => String(value ?? "").trim())
      .filter(value => value && !administrativeValues.has(value))
      .filter((value, index, values) => values.indexOf(value) === index);

    if (placeParts.length) this.fields.place.value = placeParts.join(" · ");
    this.updateSuggestedFileName();
  }

  private addPhotoFiles(files: File[]): void {
    const imageFiles = files.filter(file => file.type.startsWith("image/"));
    for (const file of imageFiles) {
      const fallbackAlt = baseName(file.name).replace(/[-_]+/g, " ");
      this.photos.push({
        id: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: URL.createObjectURL(file),
        alt: this.fields.place.value.trim() || fallbackAlt,
        caption: "",
        position: "center",
      });
    }
    this.renderPhotos();
  }

  private renderPhotos(): void {
    if (!this.photosEl) return;
    this.photosEl.empty();
    if (!this.photos.length) {
      this.photosEl.createDiv({
        cls: "footprint-studio-empty",
        text: "还没有照片。选择图片后，会在这里预览和排序。",
      });
      return;
    }

    this.photos.forEach((photo, index) => {
      const card = this.photosEl.createDiv({ cls: "footprint-studio-photo-card" });
      card.draggable = true;
      card.addEventListener("dragstart", () => {
        this.draggedPhoto = index;
        card.addClass("is-dragging");
      });
      card.addEventListener("dragend", () => card.removeClass("is-dragging"));
      card.addEventListener("dragover", event => event.preventDefault());
      card.addEventListener("drop", event => {
        event.preventDefault();
        if (this.draggedPhoto < 0 || this.draggedPhoto === index) return;
        const [moved] = this.photos.splice(this.draggedPhoto, 1);
        this.photos.splice(index, 0, moved);
        this.draggedPhoto = -1;
        this.renderPhotos();
      });

      const preview = card.createDiv({ cls: "footprint-studio-photo-preview" });
      if (photo.previewUrl) {
        preview.createEl("img", {
          attr: { src: photo.previewUrl, alt: photo.alt || `照片 ${index + 1}` },
        });
      } else {
        const missing = preview.createDiv({ cls: "footprint-studio-photo-missing" });
        setIcon(missing, "image-off");
        missing.createSpan({ text: "找不到原图" });
      }
      preview.createSpan({ cls: "footprint-studio-photo-index", text: String(index + 1) });

      const cardActions = preview.createDiv({ cls: "footprint-studio-photo-actions" });
      const up = makeButton(cardActions, "", "arrow-left");
      up.setAttribute("aria-label", "向前移动");
      up.disabled = index === 0;
      up.addEventListener("click", () => this.movePhoto(index, index - 1));
      const down = makeButton(cardActions, "", "arrow-right");
      down.setAttribute("aria-label", "向后移动");
      down.disabled = index === this.photos.length - 1;
      down.addEventListener("click", () => this.movePhoto(index, index + 1));
      const remove = makeButton(cardActions, "", "trash-2");
      remove.setAttribute("aria-label", "移除照片");
      remove.addEventListener("click", () => this.removePhoto(index));

      const fields = card.createDiv({ cls: "footprint-studio-photo-fields" });
      const alt = this.createCompactInput(fields, "替代文本", photo.alt);
      alt.addEventListener("input", () => (photo.alt = alt.value));
      const caption = this.createCompactInput(fields, "图片说明（可选）", photo.caption);
      caption.addEventListener("input", () => (photo.caption = caption.value));
      const position = this.createCompactInput(fields, "裁剪位置（可选）", photo.position);
      position.addEventListener("input", () => (photo.position = position.value));
    });
  }

  private createCompactInput(parent: HTMLElement, placeholder: string, value: string): HTMLInputElement {
    const input = parent.createEl("input", { type: "text", placeholder });
    input.value = value;
    input.addEventListener("pointerdown", event => event.stopPropagation());
    return input;
  }

  private movePhoto(from: number, to: number): void {
    if (to < 0 || to >= this.photos.length) return;
    const [photo] = this.photos.splice(from, 1);
    this.photos.splice(to, 0, photo);
    this.renderPhotos();
  }

  private removePhoto(index: number): void {
    const [photo] = this.photos.splice(index, 1);
    if (photo?.file && photo.previewUrl.startsWith("blob:")) URL.revokeObjectURL(photo.previewUrl);
    this.renderPhotos();
  }

  private disposePhotos(): void {
    for (const photo of this.photos) {
      if (photo.file && photo.previewUrl.startsWith("blob:")) URL.revokeObjectURL(photo.previewUrl);
    }
  }

  private loadBlogPosts(): BlogPostOption[] {
    const prefix = `${normalizePath(this.plugin.settings.blogFolder)}/`;
    return this.app.vault
      .getMarkdownFiles()
      .filter(file => file.path.startsWith(prefix))
      .map(file => {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const slug = String(frontmatter?.slug ?? "").trim() || file.basename;
        const title = String(frontmatter?.title ?? "").trim() || file.basename;
        return { id: slug, title, path: file.path };
      })
      .sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
  }

  private renderSelectedPosts(): void {
    if (!this.selectedPostsEl) return;
    this.selectedPostsEl.empty();
    for (const id of this.selectedPosts) {
      const post = this.blogPosts.find(item => item.id === id);
      const chip = this.selectedPostsEl.createDiv({ cls: "footprint-studio-post-chip" });
      chip.createSpan({ text: post?.title ?? id, attr: { title: id } });
      const remove = makeButton(chip, "", "x");
      remove.setAttribute("aria-label", `移除关联文章 ${post?.title ?? id}`);
      remove.addEventListener("click", () => {
        this.selectedPosts.delete(id);
        this.renderSelectedPosts();
        this.renderPostSuggestions();
      });
    }
  }

  private renderPostSuggestions(): void {
    if (!this.postsEl || !this.postSearchInput) return;
    this.postsEl.empty();
    const query = this.postSearchInput.value.trim().toLocaleLowerCase("zh-CN");
    if (!query) {
      this.postsEl.hidden = true;
      return;
    }
    const posts = this.blogPosts
      .filter(
        post =>
          !this.selectedPosts.has(post.id) &&
          `${post.title} ${post.id}`.toLocaleLowerCase("zh-CN").includes(query)
      )
      .slice(0, 8);

    if (!posts.length) {
      this.postsEl.createDiv({
        cls: "footprint-studio-post-empty",
        text: "没有匹配文章",
      });
      this.postsEl.hidden = false;
      return;
    }
    for (const post of posts) {
      const button = this.postsEl.createEl("button", {
        cls: "footprint-studio-post",
        attr: { type: "button" },
      });
      const text = button.createDiv();
      text.createEl("strong", { text: post.title });
      text.createEl("span", { text: post.id });
      button.addEventListener("mousedown", event => event.preventDefault());
      button.addEventListener("click", () => {
        this.selectedPosts.add(post.id);
        this.postSearchInput.value = "";
        this.postsEl.hidden = true;
        this.renderSelectedPosts();
        this.postSearchInput.focus();
      });
    }
    this.postsEl.hidden = false;
  }

  private async saveFootprint(button: HTMLButtonElement): Promise<void> {
    if (this.saving) return;
    const values = this.readValues();
    const required: Array<[string, string]> = [
      [values.fileName, "文件名"],
      [values.visitedAt, "日期"],
      [values.country, "国家"],
      [values.region, "省 / 地区"],
      [values.city, "城市"],
      [values.place, "地点"],
    ];
    const missing = required.find(([value]) => !value);
    if (missing) {
      new Notice(`请填写${missing[1]}`);
      return;
    }
    if (!Number.isFinite(values.lat) || !Number.isFinite(values.lng)) {
      new Notice("请在地图上选择有效坐标");
      return;
    }
    if (!this.photos.length) {
      new Notice("请至少选择一张照片");
      return;
    }

    this.saving = true;
    button.disabled = true;
    button.addClass("is-loading");
    try {
      const fileName = this.currentFile?.basename ?? sanitizeSegment(values.fileName);
      const markdownPath = this.currentFile?.path ?? normalizePath(
        `${this.plugin.settings.footprintsFolder}/${fileName}.md`
      );
      if (!this.currentFile && this.app.vault.getAbstractFileByPath(markdownPath)) {
        new Notice("同名足迹已经存在，请修改文件名");
        return;
      }

      const assetFolder = normalizePath(`${this.plugin.settings.attachmentsFolder}/${fileName}`);
      const savedPhotos: PhotoDraft[] = [];
      for (const photo of this.photos) {
        if (!photo.file) {
          savedPhotos.push(photo);
          continue;
        }
        await this.ensureFolder(assetFolder);
        const target = this.uniqueFilePath(assetFolder, photo.file.name);
        await this.app.vault.createBinary(target, await photo.file.arrayBuffer());
        const source = relativePath(markdownPath, target);
        const savedFile = this.app.vault.getAbstractFileByPath(target);
        if (photo.previewUrl.startsWith("blob:")) URL.revokeObjectURL(photo.previewUrl);
        savedPhotos.push({
          ...photo,
          file: undefined,
          source,
          previewUrl:
            savedFile instanceof TFile ? this.app.vault.getResourcePath(savedFile) : "",
        });
      }
      this.photos = savedPhotos;

      const markdown = this.buildMarkdown(values, markdownPath);
      let savedFile: TFile;
      if (this.currentFile) {
        await this.app.vault.modify(this.currentFile, markdown);
        savedFile = this.currentFile;
      } else {
        await this.ensureFolder(normalizePath(this.plugin.settings.footprintsFolder));
        savedFile = await this.app.vault.create(markdownPath, markdown);
      }
      this.currentFile = savedFile;
      this.fields.fileName.value = savedFile.basename;
      this.fields.fileName.disabled = true;
      this.renderPhotos();
      new Notice(`足迹已保存：${savedFile.path}`);
    } catch (error) {
      console.error("Footprint Studio save failed", error);
      new Notice(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.saving = false;
      button.disabled = false;
      button.removeClass("is-loading");
    }
  }

  private readValues(): {
    fileName: string;
    visitedAt: string;
    country: string;
    region: string;
    city: string;
    place: string;
    lat: number;
    lng: number;
    description: string;
  } {
    return {
      fileName: this.fields.fileName.value.trim(),
      visitedAt: this.fields.visitedAt.value,
      country: this.fields.country.value.trim(),
      region: this.fields.region.value.trim(),
      city: this.fields.city.value.trim(),
      place: this.fields.place.value.trim(),
      lat: Number(this.fields.lat.value),
      lng: Number(this.fields.lng.value),
      description: this.fields.description.value.trim(),
    };
  }

  private buildMarkdown(values: ReturnType<FootprintStudioView["readValues"]>, markdownPath: string): string {
    const lines = [
      "---",
      `visitedAt: ${values.visitedAt}`,
      `country: ${yamlString(values.country)}`,
      `region: ${yamlString(values.region)}`,
      `city: ${yamlString(values.city)}`,
      `place: ${yamlString(values.place)}`,
      "coordinates:",
      `  lat: ${values.lat}`,
      `  lng: ${values.lng}`,
    ];
    if (this.draftInput.checked) lines.push("draft: true");
    if (this.selectedPosts.size) {
      lines.push("relatedPosts:");
      for (const id of this.selectedPosts) lines.push(`  - ${yamlString(id)}`);
    }
    lines.push("photos:");
    for (const photo of this.photos) {
      if (!photo.source) continue;
      const alt = photo.alt.trim() || values.place;
      lines.push(`  - src: ${yamlString(photo.source)}`);
      lines.push(`    alt: ${yamlString(alt)}`);
      if (photo.caption.trim()) lines.push(`    caption: ${yamlString(photo.caption.trim())}`);
      if (photo.position.trim()) lines.push(`    position: ${yamlString(photo.position.trim())}`);
    }
    lines.push("---", "", values.description, "");
    return lines.join("\n");
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) await this.app.vault.createFolder(current);
      else if (!(existing instanceof TFolder)) throw new Error(`${current} 不是文件夹`);
    }
  }

  private uniqueFilePath(folder: string, originalName: string): string {
    const ext = extensionOf(originalName) || ".jpg";
    const rawBase = originalName.slice(0, originalName.length - extensionOf(originalName).length);
    const safeBase = sanitizeSegment(rawBase, "photo");
    let candidate = normalizePath(`${folder}/${safeBase}${ext}`);
    let index = 2;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${folder}/${safeBase}-${index}${ext}`);
      index += 1;
    }
    return candidate;
  }
}

class FootprintStudioSettingTab extends PluginSettingTab {
  plugin: FootprintStudioPlugin;

  constructor(app: FootprintStudioPlugin["app"], plugin: FootprintStudioPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Footprint Studio 设置" });

    this.addTextSetting("足迹目录", "生成和识别足迹 Markdown 的 Vault 相对路径。", "footprintsFolder");
    this.addTextSetting("图片目录", "新导入图片的 Vault 相对路径。每条足迹会建立子目录。", "attachmentsFolder");
    this.addTextSetting("文章目录", "用于搜索关联文章的 Markdown 目录。", "blogFolder");
    this.addTextSetting("地图瓦片地址", "支持 Leaflet 的 {s}/{z}/{x}/{y} 占位符。", "tileUrl");

    new Setting(containerEl)
      .setName("默认地图中心")
      .setDesc("新建足迹时使用的纬度和经度。")
      .addText(text =>
        text
          .setPlaceholder("纬度")
          .setValue(String(this.plugin.settings.defaultLat))
          .onChange(async value => {
            const number = Number(value);
            if (Number.isFinite(number)) {
              this.plugin.settings.defaultLat = number;
              await this.plugin.saveSettings();
            }
          })
      )
      .addText(text =>
        text
          .setPlaceholder("经度")
          .setValue(String(this.plugin.settings.defaultLng))
          .onChange(async value => {
            const number = Number(value);
            if (Number.isFinite(number)) {
              this.plugin.settings.defaultLng = number;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("默认缩放级别")
      .setDesc("建议使用 3–12。")
      .addSlider(slider =>
        slider
          .setLimits(2, 16, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.defaultZoom)
          .onChange(async value => {
            this.plugin.settings.defaultZoom = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private addTextSetting(
    name: string,
    description: string,
    key: "footprintsFolder" | "attachmentsFolder" | "blogFolder" | "tileUrl"
  ): void {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(description)
      .addText(text =>
        text
          .setValue(this.plugin.settings[key])
          .onChange(async value => {
            this.plugin.settings[key] = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }
}
