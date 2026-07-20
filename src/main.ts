import {
  App,
  FileView,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  ViewStateResult,
  getFrontMatterInfo,
  normalizePath,
  parseYaml,
  requestUrl,
  setIcon,
} from "obsidian";
import * as L from "leaflet";
import "leaflet.markercluster";
import { pinyin } from "pinyin-pro";

const VIEW_TYPE = "footprint-studio-view";
const OVERVIEW_VIEW_TYPE = "footprint-studio-overview-view";
const MAP_HEIGHT_MIN = 300;
const MAP_HEIGHT_MAX = 680;
const MAP_HEIGHT_DEFAULT = 380;

interface FootprintStudioSettings {
  footprintsFolder: string;
  attachmentsFolder: string;
  blogFolder: string;
  tileUrl: string;
  defaultLat: number;
  defaultLng: number;
  defaultZoom: number;
  mapHeight: number;
}

const DEFAULT_SETTINGS: FootprintStudioSettings = {
  footprintsFolder: "footprints",
  attachmentsFolder: "attachment/footprints",
  blogFolder: "blog",
  tileUrl: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  defaultLat: 35.8617,
  defaultLng: 104.1954,
  defaultZoom: 4,
  mapHeight: MAP_HEIGHT_DEFAULT,
};

function normalizeMapHeight(value: unknown): number {
  const height = Number(value);
  if (!Number.isFinite(height)) return MAP_HEIGHT_DEFAULT;
  return Math.min(MAP_HEIGHT_MAX, Math.max(MAP_HEIGHT_MIN, Math.round(height)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function applyMapHeightClass(element: HTMLElement, value: unknown): void {
  for (let height = MAP_HEIGHT_MIN; height <= MAP_HEIGHT_MAX; height += 20) {
    element.removeClass(`footprint-studio-map-height-${height}`);
  }
  element.addClass(`footprint-studio-map-height-${normalizeMapHeight(value)}`);
}

function normalizeSearchText(value: string): string {
  return value.toLocaleLowerCase("zh-CN");
}

function appendHighlightedText(
  parent: HTMLElement,
  value: string,
  normalizedQuery: string
): void {
  const normalizedValue = normalizeSearchText(value);
  if (
    !normalizedQuery ||
    normalizedValue.length !== value.length ||
    !normalizedValue.includes(normalizedQuery)
  ) {
    parent.append(document.createTextNode(value));
    return;
  }

  let offset = 0;
  while (offset < value.length) {
    const matchIndex = normalizedValue.indexOf(normalizedQuery, offset);
    if (matchIndex === -1) {
      parent.append(document.createTextNode(value.slice(offset)));
      break;
    }
    if (matchIndex > offset) {
      parent.append(document.createTextNode(value.slice(offset, matchIndex)));
    }
    parent.createEl("mark", {
      cls: "footprint-studio-post-match",
      text: value.slice(matchIndex, matchIndex + normalizedQuery.length),
    });
    offset = matchIndex + normalizedQuery.length;
  }
}

interface PhotoGpsCoordinates {
  lat: number;
  lng: number;
}

interface PhotoExifMetadata {
  coordinates: PhotoGpsCoordinates | null;
  capturedAt: string | null;
}

function parseTiffGps(
  view: DataView,
  tiffOffset: number,
  tiffEnd: number
): PhotoGpsCoordinates | null {
  const hasRange = (offset: number, length: number): boolean =>
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    length >= 0 &&
    offset >= tiffOffset &&
    offset <= tiffEnd - length;
  if (!hasRange(tiffOffset, 8)) return null;

  const byteOrder = view.getUint16(tiffOffset, false);
  const littleEndian = byteOrder === 0x4949;
  if (!littleEndian && byteOrder !== 0x4d4d) return null;

  const readUint16 = (offset: number): number | null =>
    hasRange(offset, 2) ? view.getUint16(offset, littleEndian) : null;
  const readUint32 = (offset: number): number | null =>
    hasRange(offset, 4) ? view.getUint32(offset, littleEndian) : null;
  if (readUint16(tiffOffset + 2) !== 42) return null;

  const findEntry = (ifdRelativeOffset: number, wantedTag: number): number | null => {
    const ifdOffset = tiffOffset + ifdRelativeOffset;
    const count = readUint16(ifdOffset);
    if (count == null || count > 1024 || !hasRange(ifdOffset + 2, count * 12)) {
      return null;
    }
    for (let index = 0; index < count; index += 1) {
      const entryOffset = ifdOffset + 2 + index * 12;
      if (readUint16(entryOffset) === wantedTag) return entryOffset;
    }
    return null;
  };

  const ifd0Offset = readUint32(tiffOffset + 4);
  if (ifd0Offset == null) return null;
  const gpsPointerEntry = findEntry(ifd0Offset, 0x8825);
  if (gpsPointerEntry == null) return null;
  const gpsPointerType = readUint16(gpsPointerEntry + 2);
  const gpsPointerCount = readUint32(gpsPointerEntry + 4);
  if ((gpsPointerType !== 4 && gpsPointerType !== 13) || gpsPointerCount !== 1) {
    return null;
  }
  const gpsIfdOffset = readUint32(gpsPointerEntry + 8);
  if (gpsIfdOffset == null) return null;

  const typeSizes: Record<number, number> = {
    1: 1,
    2: 1,
    3: 2,
    4: 4,
    5: 8,
    9: 4,
    10: 8,
    13: 4,
  };
  const fieldData = (
    entryOffset: number
  ): { offset: number; type: number; count: number } | null => {
    const type = readUint16(entryOffset + 2);
    const count = readUint32(entryOffset + 4);
    if (type == null || count == null || count > 1_000_000) return null;
    const typeSize = typeSizes[type];
    if (!typeSize) return null;
    const byteLength = typeSize * count;
    if (!Number.isSafeInteger(byteLength)) return null;
    let offset = entryOffset + 8;
    if (byteLength > 4) {
      const relativeOffset = readUint32(entryOffset + 8);
      if (relativeOffset == null) return null;
      offset = tiffOffset + relativeOffset;
    }
    return hasRange(offset, byteLength) ? { offset, type, count } : null;
  };
  const readAscii = (entryOffset: number | null): string | null => {
    if (entryOffset == null) return null;
    const field = fieldData(entryOffset);
    if (!field || field.type !== 2) return null;
    let value = "";
    for (let index = 0; index < field.count; index += 1) {
      const character = view.getUint8(field.offset + index);
      if (character !== 0) value += String.fromCharCode(character);
    }
    return value.trim().toUpperCase();
  };
  const readRationals = (entryOffset: number | null): number[] | null => {
    if (entryOffset == null) return null;
    const field = fieldData(entryOffset);
    if (!field || (field.type !== 5 && field.type !== 10) || field.count < 3) {
      return null;
    }
    const values: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      const offset = field.offset + index * 8;
      const numerator =
        field.type === 10
          ? view.getInt32(offset, littleEndian)
          : view.getUint32(offset, littleEndian);
      const denominator =
        field.type === 10
          ? view.getInt32(offset + 4, littleEndian)
          : view.getUint32(offset + 4, littleEndian);
      if (denominator === 0) return null;
      values.push(numerator / denominator);
    }
    return values;
  };

  const latitudeRef = readAscii(findEntry(gpsIfdOffset, 1));
  const latitudeDms = readRationals(findEntry(gpsIfdOffset, 2));
  const longitudeRef = readAscii(findEntry(gpsIfdOffset, 3));
  const longitudeDms = readRationals(findEntry(gpsIfdOffset, 4));
  if (
    !latitudeDms ||
    !longitudeDms ||
    (latitudeRef !== "N" && latitudeRef !== "S") ||
    (longitudeRef !== "E" && longitudeRef !== "W")
  ) {
    return null;
  }
  const validDms = ([degrees, minutes, seconds]: number[]): boolean =>
    [degrees, minutes, seconds].every(Number.isFinite) &&
    degrees >= 0 &&
    minutes >= 0 &&
    minutes < 60 &&
    seconds >= 0 &&
    seconds < 60;
  if (!validDms(latitudeDms) || !validDms(longitudeDms)) return null;

  let lat = latitudeDms[0] + latitudeDms[1] / 60 + latitudeDms[2] / 3600;
  let lng = longitudeDms[0] + longitudeDms[1] / 60 + longitudeDms[2] / 3600;
  if (latitudeRef === "S") lat *= -1;
  if (longitudeRef === "W") lng *= -1;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  return { lat, lng };
}

function normalizeExifDateTime(value: string | null): string | null {
  if (!value) return null;
  const match = value
    .replace(/\0/g, "")
    .trim()
    .match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    0,
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }
  return `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}`;
}

function parseTiffCapturedAt(
  view: DataView,
  tiffOffset: number,
  tiffEnd: number
): string | null {
  const hasRange = (offset: number, length: number): boolean =>
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    length >= 0 &&
    offset >= tiffOffset &&
    offset <= tiffEnd - length;
  if (!hasRange(tiffOffset, 8)) return null;

  const byteOrder = view.getUint16(tiffOffset, false);
  const littleEndian = byteOrder === 0x4949;
  if (!littleEndian && byteOrder !== 0x4d4d) return null;
  const readUint16 = (offset: number): number | null =>
    hasRange(offset, 2) ? view.getUint16(offset, littleEndian) : null;
  const readUint32 = (offset: number): number | null =>
    hasRange(offset, 4) ? view.getUint32(offset, littleEndian) : null;
  if (readUint16(tiffOffset + 2) !== 42) return null;

  const findEntry = (ifdRelativeOffset: number, wantedTag: number): number | null => {
    const ifdOffset = tiffOffset + ifdRelativeOffset;
    const count = readUint16(ifdOffset);
    if (count == null || count > 1024 || !hasRange(ifdOffset + 2, count * 12)) {
      return null;
    }
    for (let index = 0; index < count; index += 1) {
      const entryOffset = ifdOffset + 2 + index * 12;
      if (readUint16(entryOffset) === wantedTag) return entryOffset;
    }
    return null;
  };
  const readAscii = (entryOffset: number | null): string | null => {
    if (entryOffset == null || readUint16(entryOffset + 2) !== 2) return null;
    const count = readUint32(entryOffset + 4);
    if (count == null || count < 1 || count > 1024) return null;
    let offset = entryOffset + 8;
    if (count > 4) {
      const relativeOffset = readUint32(entryOffset + 8);
      if (relativeOffset == null) return null;
      offset = tiffOffset + relativeOffset;
    }
    if (!hasRange(offset, count)) return null;
    let value = "";
    for (let index = 0; index < count; index += 1) {
      value += String.fromCharCode(view.getUint8(offset + index));
    }
    return value;
  };

  const ifd0Offset = readUint32(tiffOffset + 4);
  if (ifd0Offset == null) return null;
  let exifIfdOffset: number | null = null;
  const exifPointer = findEntry(ifd0Offset, 0x8769);
  if (exifPointer != null) {
    const type = readUint16(exifPointer + 2);
    const count = readUint32(exifPointer + 4);
    if ((type === 4 || type === 13) && count === 1) {
      exifIfdOffset = readUint32(exifPointer + 8);
    }
  }

  const original =
    exifIfdOffset == null
      ? null
      : readAscii(findEntry(exifIfdOffset, 0x9003)) ??
        readAscii(findEntry(exifIfdOffset, 0x9004));
  const fallback = readAscii(findEntry(ifd0Offset, 0x0132));
  return normalizeExifDateTime(original ?? fallback);
}

function extractPhotoMetadata(buffer: ArrayBuffer): PhotoExifMetadata | null {
  const view = new DataView(buffer);
  if (view.byteLength < 8) return null;
  try {
    const isTiffHeader = (offset: number): boolean => {
      if (offset < 0 || offset + 4 > view.byteLength) return false;
      const order = view.getUint16(offset, false);
      const littleEndian = order === 0x4949;
      return (
        (littleEndian || order === 0x4d4d) &&
        view.getUint16(offset + 2, littleEndian) === 42
      );
    };
    const readMetadata = (tiffOffset: number, tiffEnd: number): PhotoExifMetadata | null => {
      const coordinates = parseTiffGps(view, tiffOffset, tiffEnd);
      const capturedAt = parseTiffCapturedAt(view, tiffOffset, tiffEnd);
      return coordinates || capturedAt ? { coordinates, capturedAt } : null;
    };
    if (isTiffHeader(0)) return readMetadata(0, view.byteLength);
    if (view.getUint16(0, false) !== 0xffd8) return null;

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < view.byteLength && view.getUint8(offset) === 0xff) offset += 1;
      if (offset >= view.byteLength) break;
      const marker = view.getUint8(offset);
      offset += 1;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > view.byteLength) break;
      const segmentLength = view.getUint16(offset, false);
      if (segmentLength < 2 || offset + segmentLength > view.byteLength) break;
      const payloadOffset = offset + 2;
      const segmentEnd = offset + segmentLength;
      const hasExifHeader =
        marker === 0xe1 &&
        payloadOffset + 6 <= segmentEnd &&
        view.getUint32(payloadOffset, false) === 0x45786966 &&
        view.getUint16(payloadOffset + 4, false) === 0;
      if (hasExifHeader) {
        const tiffOffset = payloadOffset + 6;
        if (isTiffHeader(tiffOffset)) {
          const metadata = readMetadata(tiffOffset, segmentEnd);
          if (metadata) return metadata;
        }
      }
      offset += segmentLength;
    }
  } catch (error) {
    console.warn("Footprint Studio 无法解析照片 EXIF", error);
  }
  return null;
}

interface PhotoDraft {
  id: string;
  file?: File;
  source?: string;
  previewUrl: string;
  alt: string;
  caption: string;
  position: string;
  hidden: boolean;
  coordinates: PhotoGpsCoordinates | null;
  capturedAt: string;
  metadataPending: boolean;
}

interface BlogPostOption {
  id: string;
  title: string;
  path: string;
  keywords: string[];
}

interface FootprintOverviewPhoto {
  source: string;
  previewUrl: string;
  alt: string;
  caption: string;
  hidden: boolean;
}

interface FootprintOverviewPost {
  id: string;
  title: string;
  file: TFile | null;
}

interface FootprintOverviewRecord {
  file: TFile;
  visitedAt: string;
  country: string;
  region: string;
  city: string;
  place: string;
  lat: number;
  lng: number;
  draft: boolean;
  photos: FootprintOverviewPhoto[];
  relatedPosts: FootprintOverviewPost[];
  note: string;
}

interface FootprintOverviewGroup {
  lat: number;
  lng: number;
  records: FootprintOverviewRecord[];
}

interface NominatimAddress {
  country?: string;
  state?: string;
  state_district?: string;
  province?: string;
  city?: string;
  town?: string;
  municipality?: string;
  county?: string;
  city_district?: string;
  district?: string;
  borough?: string;
  village?: string;
  township?: string;
  suburb?: string;
  neighbourhood?: string;
  quarter?: string;
  hamlet?: string;
  road?: string;
  pedestrian?: string;
  residential?: string;
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
  | "capturedTime"
  | "country"
  | "region"
  | "city"
  | "district"
  | "town"
  | "street"
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

function timeString(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return [value.getHours(), value.getMinutes(), value.getSeconds()]
      .map(part => String(part).padStart(2, "0"))
      .join(":");
  }
  const match = String(value ?? "").match(/[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  return match ? `${match[1]}:${match[2]}:${match[3] ?? "00"}` : "";
}

function dateTimeString(value: unknown): string {
  if (value == null || String(value).trim() === "") return "";
  const time = timeString(value);
  return time ? `${dateString(value)}T${time}` : "";
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
    .replace(/[\\/:*?"<>|#^[\]]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return safe || fallback;
}

function placePinyinSegment(value: string): string {
  return pinyin(value, {
    toneType: "none",
    type: "array",
    nonZh: "consecutive",
  })
    .join("")
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .toLowerCase();
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
  const button = parent.createEl("button", {
    cls: className,
    attr: { type: "button" },
  });
  if (icon) {
    const iconEl = button.createSpan({ cls: "footprint-studio-button-icon" });
    setIcon(iconEl, icon);
  }
  button.createSpan({ text: label });
  return button;
}

class PhotoPreviewModal extends Modal {
  constructor(
    app: App,
    private imageUrl: string,
    private imageAlt: string,
    private imageCaption: string
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("footprint-studio-photo-modal");
    this.setTitle(this.imageAlt || "照片预览");
    const image = this.contentEl.createEl("img", {
      attr: { src: this.imageUrl, alt: this.imageAlt || "照片预览" },
    });
    image.draggable = false;
    if (this.imageCaption) {
      this.contentEl.createEl("p", {
        cls: "footprint-studio-photo-modal-caption",
        text: this.imageCaption,
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export default class FootprintStudioPlugin extends Plugin {
  settings: FootprintStudioSettings = DEFAULT_SETTINGS;
  private autoOpenRequest = 0;
  private knownLeaves = new WeakSet<WorkspaceLeaf>();
  private transientLeaves = new WeakSet<WorkspaceLeaf>();
  private nativeMarkdownLeaves = new WeakMap<WorkspaceLeaf, string>();

  async onload(): Promise<void> {
    const storedSettings: unknown = await this.loadData();
    const stored = asRecord(storedSettings);
    this.settings = {
      footprintsFolder:
        typeof stored?.footprintsFolder === "string"
          ? stored.footprintsFolder
          : DEFAULT_SETTINGS.footprintsFolder,
      attachmentsFolder:
        typeof stored?.attachmentsFolder === "string"
          ? stored.attachmentsFolder
          : DEFAULT_SETTINGS.attachmentsFolder,
      blogFolder:
        typeof stored?.blogFolder === "string"
          ? stored.blogFolder
          : DEFAULT_SETTINGS.blogFolder,
      tileUrl:
        typeof stored?.tileUrl === "string"
          ? stored.tileUrl
          : DEFAULT_SETTINGS.tileUrl,
      defaultLat:
        typeof stored?.defaultLat === "number"
          ? stored.defaultLat
          : DEFAULT_SETTINGS.defaultLat,
      defaultLng:
        typeof stored?.defaultLng === "number"
          ? stored.defaultLng
          : DEFAULT_SETTINGS.defaultLng,
      defaultZoom:
        typeof stored?.defaultZoom === "number"
          ? stored.defaultZoom
          : DEFAULT_SETTINGS.defaultZoom,
      mapHeight: normalizeMapHeight(stored?.mapHeight),
    };
    this.settings.mapHeight = normalizeMapHeight(this.settings.mapHeight);

    this.registerView(VIEW_TYPE, leaf => new FootprintStudioView(leaf, this));
    this.registerView(
      OVERVIEW_VIEW_TYPE,
      leaf => new FootprintOverviewView(leaf, this)
    );
    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.iterateAllLeaves(leaf => this.knownLeaves.add(leaf));
      this.registerEvent(
        this.app.workspace.on("file-open", file => {
          if (!this.isFootprintFile(file)) return;
          this.scheduleAutoOpen(file);
        })
      );
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", leaf => {
          if (leaf && !this.knownLeaves.has(leaf)) this.transientLeaves.add(leaf);
          if (leaf) this.knownLeaves.add(leaf);
          const file = this.getLeafFile(leaf);
          const nativePath = leaf ? this.nativeMarkdownLeaves.get(leaf) : undefined;
          if (leaf && nativePath && nativePath !== file?.path) {
            this.nativeMarkdownLeaves.delete(leaf);
          }
          if (this.isFootprintFile(file)) this.scheduleAutoOpen(file, leaf);
        })
      );
    });
    this.addRibbonIcon("map-pinned", "足迹总览", () =>
      void this.openOverview()
    );

    this.addCommand({
      id: "open-footprint-overview",
      name: "打开足迹总览",
      callback: () => this.openOverview(),
    });

    this.addCommand({
      id: "create-footprint",
      name: "新建足迹",
      callback: () => this.openStudio(),
    });

    this.addCommand({
      id: "save-current-footprint",
      name: "保存当前足迹",
      checkCallback: checking => {
        const view = this.app.workspace.getActiveViewOfType(FootprintStudioView);
        if (!view) return false;
        if (!checking) view.requestSave();
        return true;
      },
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
        menu.addItem(item =>
          item
            .setTitle("使用原生 Markdown 打开")
            .setIcon("file-text")
            .onClick(() => void this.openNativeMarkdown(file))
        );
      })
    );

    this.addSettingTab(new FootprintStudioSettingTab(this.app, this));
  }

  onunload(): void {
    for (const type of [VIEW_TYPE, OVERVIEW_VIEW_TYPE]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        leaf.detach();
      }
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  refreshMapHeights(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof FootprintStudioView) {
        leaf.view.setMapHeight(this.settings.mapHeight);
      }
    }
  }

  private isFootprintFile(file: unknown): file is TFile {
    const prefix = `${normalizePath(this.settings.footprintsFolder)}/`;
    return (
      file instanceof TFile &&
      file.extension.toLowerCase() === "md" &&
      file.path.startsWith(prefix)
    );
  }

  private getLeafFile(leaf: WorkspaceLeaf | null | undefined): TFile | null {
    const file = (leaf?.view as { file?: TFile | null } | undefined)?.file;
    return file instanceof TFile ? file : null;
  }

  private scheduleAutoOpen(file: TFile, preferredLeaf?: WorkspaceLeaf | null): void {
    const request = ++this.autoOpenRequest;
    window.setTimeout(() => {
      if (request !== this.autoOpenRequest) return;
      const leaf = this.resolveOpenedLeaf(file, preferredLeaf);
      if (leaf && this.nativeMarkdownLeaves.get(leaf) === file.path) return;
      const existingLeaf = this.findStudioLeaf(file);
      if (existingLeaf) {
        void this.app.workspace.revealLeaf(existingLeaf);
        if (leaf && leaf !== existingLeaf && this.transientLeaves.has(leaf)) {
          this.transientLeaves.delete(leaf);
          leaf.detach();
        }
        return;
      }
      if (!leaf || leaf.view instanceof FootprintStudioView) return;
      this.transientLeaves.delete(leaf);
      void this.openStudio(file, leaf);
    }, 0);
  }

  private findStudioLeaf(file: TFile): WorkspaceLeaf | null {
    const leaves = this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .filter(
        leaf =>
          leaf.view instanceof FootprintStudioView &&
          leaf.view.getEditingPath() === file.path
      );
    const recentLeaf = this.app.workspace.getMostRecentLeaf();
    return leaves.find(leaf => leaf === recentLeaf) ?? leaves[0] ?? null;
  }

  private async openNativeMarkdown(file: TFile): Promise<void> {
    const existingLeaf = this.app.workspace
      .getLeavesOfType("markdown")
      .find(leaf => this.getLeafFile(leaf)?.path === file.path);
    const leaf = existingLeaf ?? this.app.workspace.getLeaf("tab");
    this.nativeMarkdownLeaves.set(leaf, file.path);
    try {
      if (!existingLeaf) await leaf.openFile(file);
      await this.app.workspace.revealLeaf(leaf);
    } catch (error) {
      this.nativeMarkdownLeaves.delete(leaf);
      console.error("Footprint Studio 原生打开失败", error);
      new Notice("无法使用原生 Markdown 打开这篇足迹");
    }
  }

  private resolveOpenedLeaf(
    file: TFile,
    preferredLeaf?: WorkspaceLeaf | null
  ): WorkspaceLeaf | null {
    const matches = (leaf: WorkspaceLeaf | null | undefined): leaf is WorkspaceLeaf =>
      Boolean(
        leaf &&
          leaf.view.getViewType() === "markdown" &&
          this.getLeafFile(leaf)?.path === file.path
      );

    if (matches(preferredLeaf)) return preferredLeaf;

    const recentLeaf = this.app.workspace.getMostRecentLeaf();
    if (matches(recentLeaf)) return recentLeaf;

    const candidates: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves(leaf => {
      if (matches(leaf)) candidates.push(leaf);
    });
    return candidates.length === 1 ? candidates[0] : null;
  }

  async openStudio(file?: TFile, targetLeaf?: WorkspaceLeaf): Promise<void> {
    if (file) {
      const existingLeaf = this.findStudioLeaf(file);
      if (existingLeaf) {
        await this.app.workspace.revealLeaf(existingLeaf);
        return;
      }
    }

    const leaf = targetLeaf ?? this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE,
      state: { file: file?.path ?? null },
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (
      view instanceof FootprintStudioView &&
      view.getEditingPath() !== (file?.path ?? null)
    ) {
      await view.setState({ file: file?.path ?? null }, { history: false });
    }
  }

  async openOverview(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(OVERVIEW_VIEW_TYPE)[0];
    if (existingLeaf) {
      await this.app.workspace.revealLeaf(existingLeaf);
      if (existingLeaf.view instanceof FootprintOverviewView) {
        await existingLeaf.view.refresh();
      }
      return;
    }

    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: OVERVIEW_VIEW_TYPE,
      active: true,
    });
    await this.app.workspace.revealLeaf(leaf);
  }
}

function overviewDateLabel(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return value;
  return (
    Number(match[1]) +
    "年" +
    Number(match[2]) +
    "月" +
    Number(match[3]) +
    "日"
  );
}

function overviewMarkerHtml(
  cover: string,
  count: number,
  hasDraft: boolean,
  clustered = false
): string {
  const marker = createDiv({
    cls: [
      "footprint-overview-marker",
      hasDraft ? "is-draft" : "",
      clustered ? "is-cluster" : "",
    ].filter(Boolean),
  });
  const visual = marker.createDiv({ cls: "footprint-overview-marker-visual" });
  if (cover) {
    visual.createEl("img", { attr: { src: cover, alt: "" } });
  } else {
    const fallback = visual.createSpan({
      cls: "footprint-overview-marker-fallback",
    });
    setIcon(fallback, "image");
  }
  marker.createSpan({
    cls: "footprint-overview-marker-count",
    text: String(Math.max(1, count)),
  });
  if (hasDraft) {
    marker.createSpan({ cls: "footprint-overview-marker-draft", text: "稿" });
  }
  return marker.outerHTML;
}

function groupNearbyFootprints(
  records: FootprintOverviewRecord[],
  distance = 30
): FootprintOverviewGroup[] {
  const earthRadius = 6_378_137;
  const cellSize = distance;
  const groups: Array<FootprintOverviewGroup & { x: number; y: number }> = [];
  const buckets = new Map<string, number[]>();
  const project = (lat: number, lng: number) => ({
    x: (earthRadius * lng * Math.PI) / 180,
    y:
      earthRadius *
      Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
  });

  for (const record of records) {
    const point = project(record.lat, record.lng);
    const latitudeScale = Math.max(
      Math.cos((record.lat * Math.PI) / 180),
      0.18
    );
    const projectedDistance = distance / latitudeScale;
    const bucketX = Math.floor(point.x / cellSize);
    const bucketY = Math.floor(point.y / cellSize);
    const radius = Math.ceil(projectedDistance / cellSize);
    let matchedIndex = -1;

    for (
      let offsetX = -radius;
      offsetX <= radius && matchedIndex < 0;
      offsetX += 1
    ) {
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        const key = bucketX + offsetX + ":" + (bucketY + offsetY);
        const candidates = buckets.get(key) ?? [];
        matchedIndex =
          candidates.find(index => {
            const group = groups[index];
            return (
              Math.hypot(group.x - point.x, group.y - point.y) <=
              projectedDistance
            );
          }) ?? -1;
        if (matchedIndex >= 0) break;
      }
    }

    if (matchedIndex >= 0) {
      groups[matchedIndex].records.push(record);
      continue;
    }

    const groupIndex = groups.length;
    groups.push({
      lat: record.lat,
      lng: record.lng,
      x: point.x,
      y: point.y,
      records: [record],
    });
    const key = bucketX + ":" + bucketY;
    const bucket = buckets.get(key) ?? [];
    bucket.push(groupIndex);
    buckets.set(key, bucket);
  }

  return groups.map(({ lat, lng, records: groupRecords }) => ({
    lat,
    lng,
    records: groupRecords,
  }));
}

class FootprintOverviewView extends ItemView {
  private plugin: FootprintStudioPlugin;
  private map: L.Map | null = null;
  private clusters: L.MarkerClusterGroup | null = null;
  private markerGroups = new WeakMap<L.Marker, FootprintOverviewGroup>();
  private resizeObserver: ResizeObserver | null = null;
  private resizeFrame = 0;
  private refreshTimer = 0;
  private refreshRequest = 0;
  private records: FootprintOverviewRecord[] = [];
  private groups: FootprintOverviewGroup[] = [];
  private selectedGroup: FootprintOverviewGroup | null = null;
  private summaryEl!: HTMLElement;
  private mapEl!: HTMLElement;
  private panelEl!: HTMLElement;
  private panelTitleEl!: HTMLElement;
  private panelBodyEl!: HTMLElement;
  private emptyEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: FootprintStudioPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return OVERVIEW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "足迹总览";
  }

  getIcon(): string {
    return "map";
  }

  async onOpen(): Promise<void> {
    this.renderView();
    await new Promise<void>(resolve =>
      window.requestAnimationFrame(() => resolve())
    );
    this.createMap();
    await this.refresh(true);

    const schedule = (file: TFile) => {
      if (this.isFootprintFile(file)) this.scheduleRefresh();
    };
    this.registerEvent(
      this.app.metadataCache.on("changed", file => schedule(file))
    );
    this.registerEvent(
      this.app.vault.on("delete", file => {
        if (file instanceof TFile && this.isFootprintFile(file)) {
          this.scheduleRefresh();
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const prefix =
          normalizePath(this.plugin.settings.footprintsFolder) + "/";
        if (
          (file instanceof TFile && this.isFootprintFile(file)) ||
          oldPath.startsWith(prefix)
        ) {
          this.scheduleRefresh();
        }
      })
    );
  }

  async onClose(): Promise<void> {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeFrame) window.cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = 0;
    this.clusters?.clearLayers();
    this.clusters = null;
    this.map?.remove();
    this.map = null;
  }

  async refresh(fitBounds = false): Promise<void> {
    const request = ++this.refreshRequest;
    const records = await this.loadRecords();
    if (request !== this.refreshRequest) return;
    this.records = records;
    this.groups = groupNearbyFootprints(records, 30);
    const draftCount = records.filter(record => record.draft).length;
    this.summaryEl.textContent =
      records.length + " 个足迹 · " + draftCount + " 个草稿";
    this.renderMarkers(fitBounds);

    if (this.selectedGroup) {
      const selectedPaths = new Set(
        this.selectedGroup.records.map(record => record.file.path)
      );
      const refreshedGroup = this.groups.find(group =>
        group.records.some(record => selectedPaths.has(record.file.path))
      );
      if (refreshedGroup) this.selectGroup(refreshedGroup);
      else this.closePanel();
    }
  }

  private renderView(): void {
    this.contentEl.empty();
    this.contentEl.addClass(
      "footprint-studio-view",
      "footprint-overview-view"
    );
    const header = this.contentEl.createDiv({
      cls: "footprint-overview-header",
    });
    const heading = header.createDiv({ cls: "footprint-overview-heading" });
    heading.createEl("h2", { text: "全部足迹" });
    this.summaryEl = heading.createEl("p", { text: "正在读取足迹…" });
    const actions = header.createDiv({ cls: "footprint-overview-actions" });
    const refreshButton = makeButton(actions, "刷新", "refresh-cw");
    refreshButton.addEventListener("click", () => void this.refresh());
    const newButton = makeButton(actions, "新建足迹", "plus", "mod-cta");
    newButton.addEventListener("click", () => void this.plugin.openStudio());

    const shell = this.contentEl.createDiv({
      cls: "footprint-overview-shell",
    });
    this.mapEl = shell.createDiv({ cls: "footprint-overview-map" });
    this.mapEl.setAttribute("aria-label", "全部足迹地图");
    this.emptyEl = shell.createDiv({
      cls: "footprint-overview-empty",
      text: "足迹目录中还没有可定位的记录。",
    });
    this.emptyEl.hidden = true;

    this.panelEl = shell.createEl("aside", {
      cls: "footprint-overview-panel",
      attr: { "aria-hidden": "true" },
    });
    this.panelEl.inert = true;
    const panelHeader = this.panelEl.createDiv({
      cls: "footprint-overview-panel-header",
    });
    this.panelTitleEl = panelHeader.createEl("h3", { text: "足迹详情" });
    const closeButton = panelHeader.createEl("button", {
      cls: "footprint-overview-panel-close",
      attr: {
        type: "button",
        "aria-label": "关闭详情",
        title: "关闭详情",
      },
    });
    setIcon(closeButton, "x");
    closeButton.addEventListener("click", () => this.closePanel());
    this.registerDomEvent(this.contentEl, "keydown", event => {
      if (event.key === "Escape" && this.selectedGroup) this.closePanel();
    });
    this.panelBodyEl = this.panelEl.createDiv({
      cls: "footprint-overview-panel-body",
    });
  }

  private createMap(): void {
    this.map = L.map(this.mapEl, {
      zoomControl: false,
      scrollWheelZoom: true,
      attributionControl: true,
    }).setView(
      [this.plugin.settings.defaultLat, this.plugin.settings.defaultLng],
      this.plugin.settings.defaultZoom
    );
    const controls = this.mapEl.createDiv({
      cls: "footprint-overview-map-controls",
    });
    const addControl = (label: string, icon: string, action: () => void) => {
      const button = controls.createEl("button", {
        attr: { type: "button", "aria-label": label, title: label },
      });
      setIcon(button, icon);
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        action();
      });
    };
    addControl("返回初始视图", "home", () => this.fitOverviewView());
    addControl("放大", "plus", () => this.map?.zoomIn());
    addControl("缩小", "minus", () => this.map?.zoomOut());
    L.DomEvent.disableClickPropagation(controls);
    L.DomEvent.disableScrollPropagation(controls);
    L.tileLayer(this.plugin.settings.tileUrl, {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors",
    }).addTo(this.map);
    const leafletRuntime =
      (L as unknown as { default?: typeof L }).default ?? L;
    if (!leafletRuntime?.markerClusterGroup) {
      throw new Error("Leaflet MarkerCluster 未正确加载");
    }
    this.clusters = leafletRuntime.markerClusterGroup({
      showCoverageOnHover: false,
      zoomToBoundsOnClick: true,
      spiderfyOnMaxZoom: false,
      removeOutsideVisibleBounds: true,
      maxClusterRadius: 52,
      disableClusteringAtZoom: 17,
      iconCreateFunction: cluster => {
        const childMarkers = cluster.getAllChildMarkers();
        const groups = childMarkers
          .map(marker => this.markerGroups.get(marker))
          .filter((group): group is FootprintOverviewGroup => Boolean(group));
        const records = groups.flatMap(group => group.records);
        const cover = this.coverOf(records);
        const photoCount = records.reduce(
          (total, record) => total + record.photos.length,
          0
        );
        return L.divIcon({
          className: "footprint-overview-map-icon",
          html: overviewMarkerHtml(
            cover,
            photoCount || records.length,
            records.some(record => record.draft),
            true
          ),
          iconSize: [46, 53],
          iconAnchor: [23, 52],
        });
      },
    });
    this.clusters.addTo(this.map);
    this.map.on("click", () => this.closePanel());

    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeFrame) window.cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = window.requestAnimationFrame(() => {
        this.resizeFrame = 0;
        this.map?.invalidateSize({ pan: false, debounceMoveend: true });
      });
    });
    this.resizeObserver.observe(this.mapEl);
  }

  private renderMarkers(fitBounds: boolean): void {
    if (!this.map || !this.clusters) return;
    this.clusters.clearLayers();
    this.markerGroups = new WeakMap<L.Marker, FootprintOverviewGroup>();

    for (const group of this.groups) {
      const records = group.records;
      const photoCount = records.reduce(
        (total, record) => total + record.photos.length,
        0
      );
      const icon = L.divIcon({
        className: "footprint-overview-map-icon",
        html: overviewMarkerHtml(
          this.coverOf(records),
          photoCount || records.length,
          records.some(record => record.draft)
        ),
        iconSize: [44, 51],
        iconAnchor: [22, 50],
      });
      const marker = L.marker([group.lat, group.lng], {
        icon,
        title:
          records.length > 1
            ? records.length + " 条同地点足迹"
            : records[0].place +
              " · " +
              overviewDateLabel(records[0].visitedAt),
        riseOnHover: true,
        keyboard: true,
      });
      marker.on("click", () => this.selectGroup(group));
      this.markerGroups.set(marker, group);
      this.clusters.addLayer(marker);
    }

    this.emptyEl.hidden = this.groups.length > 0;
    if (fitBounds) this.fitOverviewView();
  }

  private fitOverviewView(): void {
    if (!this.map) return;
    this.closePanel();
    if (this.groups.length > 1) {
      const bounds = L.latLngBounds(
        this.groups.map(group => [group.lat, group.lng] as L.LatLngTuple)
      );
      this.map.fitBounds(bounds, { padding: [52, 52], maxZoom: 8 });
    } else if (this.groups.length === 1) {
      this.map.setView([this.groups[0].lat, this.groups[0].lng], 12);
    } else {
      this.map.setView(
        [this.plugin.settings.defaultLat, this.plugin.settings.defaultLng],
        this.plugin.settings.defaultZoom
      );
    }
  }

  private selectGroup(group: FootprintOverviewGroup): void {
    this.selectedGroup = group;
    const records = [...group.records].sort((a, b) =>
      b.visitedAt.localeCompare(a.visitedAt)
    );
    this.panelTitleEl.textContent =
      records.length > 1
        ? "同一地点 · " + records.length + " 条足迹"
        : records[0].place;
    this.panelBodyEl.empty();
    for (const record of records) this.renderRecord(record);
    this.panelEl.inert = false;
    this.panelEl.addClass("is-open");
    this.panelEl.setAttribute("aria-hidden", "false");
  }

  private closePanel(): void {
    this.selectedGroup = null;
    if (this.panelEl?.contains(document.activeElement)) this.mapEl?.focus();
    this.panelEl?.removeClass("is-open");
    this.panelEl?.setAttribute("aria-hidden", "true");
    if (this.panelEl) this.panelEl.inert = true;
  }

  private renderRecord(record: FootprintOverviewRecord): void {
    const article = this.panelBodyEl.createEl("article", {
      cls: "footprint-overview-record",
    });
    const header = article.createDiv({
      cls: "footprint-overview-record-header",
    });
    const copy = header.createDiv({
      cls: "footprint-overview-record-copy",
    });
    const title = copy.createEl("h4", { text: record.place });
    if (record.draft) {
      title.createSpan({
        cls: "footprint-overview-draft-badge",
        text: "草稿",
      });
    }
    copy.createEl("p", {
      text: [overviewDateLabel(record.visitedAt), record.city, record.region]
        .filter(Boolean)
        .join(" · "),
    });
    const editButton = makeButton(header, "编辑", "square-pen");
    editButton.addEventListener(
      "click",
      () => void this.plugin.openStudio(record.file)
    );

    if (record.note) {
      article.createEl("p", {
        cls: "footprint-overview-note",
        text: record.note,
      });
    }

    if (record.relatedPosts.length) {
      const related = article.createDiv({
        cls: "footprint-overview-related-posts",
      });
      const relatedLabel = related.createDiv({
        cls: "footprint-overview-related-label",
      });
      setIcon(relatedLabel, "file-text");
      relatedLabel.createSpan({
        text: record.relatedPosts.length + " 篇关联文章",
      });
      const relatedList = related.createDiv({
        cls: "footprint-overview-related-list",
      });
      for (const post of record.relatedPosts) {
        const button = relatedList.createEl("button", {
          attr: {
            type: "button",
            title: post.file ? `打开文章：${post.title}` : post.title,
          },
        });
        button.createSpan({ text: post.title });
        const arrow = button.createSpan({
          cls: "footprint-overview-related-arrow",
        });
        setIcon(arrow, "arrow-up-right");
        button.disabled = !post.file;
        if (post.file) {
          button.addEventListener("mousedown", event => event.preventDefault());
          button.addEventListener("click", () => void this.openRelatedPost(post));
        }
      }
    }

    if (record.photos.length) {
      const photos = article.createDiv({
        cls:
          "footprint-overview-photos" +
          (record.photos.length === 4 ? " is-four" : ""),
      });
      for (const photo of record.photos) {
        const button = photos.createEl("button", {
          cls:
            "footprint-overview-photo" + (photo.hidden ? " is-hidden" : ""),
          attr: {
            type: "button",
            title: photo.hidden
              ? "网站隐藏照片，点击预览"
              : "点击预览照片",
          },
        });
        button.createEl("img", {
          attr: {
            src: photo.previewUrl,
            alt: photo.alt || record.place,
            loading: "lazy",
          },
        });
        if (photo.hidden) {
          const badge = button.createSpan({
            cls: "footprint-overview-photo-hidden",
          });
          setIcon(badge, "eye-off");
        }
        button.addEventListener("click", () => {
          new PhotoPreviewModal(
            this.app,
            photo.previewUrl,
            photo.alt || record.place,
            photo.caption
          ).open();
        });
      }
    }

  }

  private async openRelatedPost(post: FootprintOverviewPost): Promise<void> {
    if (!post.file) return;
    const existingLeaf = this.app.workspace
      .getLeavesOfType("markdown")
      .find(
        leaf =>
          (leaf.view as unknown as { file?: TFile | null }).file?.path ===
          post.file?.path
    );
    if (existingLeaf) {
      await this.app.workspace.revealLeaf(existingLeaf);
      this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(post.file, { active: true });
    await this.app.workspace.revealLeaf(leaf);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  private coverOf(records: FootprintOverviewRecord[]): string {
    for (const record of records) {
      const photo = record.photos.find(item => item.previewUrl);
      if (photo) return photo.previewUrl;
    }
    return "";
  }

  private async loadOverviewPosts(): Promise<
    Map<string, FootprintOverviewPost>
  > {
    const prefix = normalizePath(this.plugin.settings.blogFolder) + "/";
    const files = this.app.vault.getFiles().filter(file => {
      const extension = file.extension.toLowerCase();
      return (
        file.path.startsWith(prefix) &&
        (extension === "md" || extension === "mdx")
      );
    });
    const posts = await Promise.all(
      files.map(async file => {
        let frontmatter = asRecord(
          this.app.metadataCache.getFileCache(file)?.frontmatter as unknown
        );
        if (!frontmatter) {
          const markdown = await this.app.vault.cachedRead(file);
          const match = markdown.match(
            /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
          );
          if (match) {
            frontmatter = asRecord(parseYaml(match[1]) as unknown);
          }
        }
        const id = String(frontmatter?.slug ?? "").trim() || file.basename;
        const title =
          String(frontmatter?.title ?? "").trim() || file.basename;
        return { id, title, file } satisfies FootprintOverviewPost;
      })
    );
    const index = new Map<string, FootprintOverviewPost>();
    for (const post of posts) {
      index.set(post.id, post);
      if (post.file && !index.has(post.file.basename)) {
        index.set(post.file.basename, post);
      }
    }
    return index;
  }

  private async loadRecords(): Promise<FootprintOverviewRecord[]> {
    const prefix =
      normalizePath(this.plugin.settings.footprintsFolder) + "/";
    const relatedPostIndex = await this.loadOverviewPosts();
    const files = this.app.vault
      .getMarkdownFiles()
      .filter(file => file.path.startsWith(prefix));
    const records = await Promise.all(
      files.map(async file => {
        const markdown = await this.app.vault.cachedRead(file);
        let frontmatter = asRecord(
          this.app.metadataCache.getFileCache(file)?.frontmatter as unknown
        );
        if (!frontmatter) {
          const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          if (match) {
            frontmatter = asRecord(parseYaml(match[1]) as unknown);
          }
        }
        if (!frontmatter) return null;
        const coordinates = asRecord(frontmatter.coordinates);
        const lat = Number(coordinates?.lat);
        const lng = Number(coordinates?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

        const photos = (
          Array.isArray(frontmatter.photos) ? frontmatter.photos : []
        )
          .map((value: unknown): FootprintOverviewPhoto | null => {
            const photo = asRecord(value);
            if (!photo) return null;
            const source = String(photo.src ?? "");
            if (!source) return null;
            const linked = this.app.metadataCache.getFirstLinkpathDest(
              source,
              file.path
            );
            return {
              source,
              previewUrl:
                linked instanceof TFile
                  ? this.app.vault.getResourcePath(linked)
                  : "",
              alt: String(photo.alt ?? ""),
              caption: String(photo.caption ?? ""),
              hidden: Boolean(photo.hidden),
            };
          })
          .filter(
            (photo): photo is FootprintOverviewPhoto =>
              Boolean(photo?.previewUrl)
          );
        const relatedPostIds = (
          Array.isArray(frontmatter.relatedPosts)
            ? frontmatter.relatedPosts
            : []
        )
          .map((value: unknown) => String(value).trim())
          .filter(Boolean);
        const relatedPosts = relatedPostIds.map(
          id => relatedPostIndex.get(id) ?? { id, title: id, file: null }
        );

        return {
          file,
          visitedAt: dateString(frontmatter.visitedAt),
          country: String(frontmatter.country ?? ""),
          region: String(frontmatter.region ?? ""),
          city: String(frontmatter.city ?? ""),
          place: String(frontmatter.place ?? file.basename),
          lat,
          lng,
          draft: Boolean(frontmatter.draft),
          photos,
          relatedPosts,
          note: stripFrontmatter(markdown).trim(),
        } satisfies FootprintOverviewRecord;
      })
    );
    return records
      .filter(
        (record): record is FootprintOverviewRecord => Boolean(record)
      )
      .sort((a, b) => b.visitedAt.localeCompare(a.visitedAt));
  }

  private isFootprintFile(file: TFile): boolean {
    const prefix =
      normalizePath(this.plugin.settings.footprintsFolder) + "/";
    return (
      file.extension.toLowerCase() === "md" &&
      file.path.startsWith(prefix)
    );
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = 0;
      void this.refresh();
    }, 180);
  }
}

class FootprintStudioView extends FileView {
  private plugin: FootprintStudioPlugin;
  private map: L.Map | null = null;
  private mapResizeObserver: ResizeObserver | null = null;
  private mapResizeFrame = 0;
  private marker: L.Marker | null = null;
  private savedCoordinates: PhotoGpsCoordinates | null = null;
  private resetMapButton: HTMLAnchorElement | null = null;
  private get currentFile(): TFile | null {
    return this.file;
  }

  private set currentFile(file: TFile | null) {
    this.file = file;
  }
  private photos: PhotoDraft[] = [];
  private pendingPhotoDeletes = new Set<string>();
  private blogPosts: BlogPostOption[] = [];
  private selectedPosts = new Set<string>();
  private readonly instanceId = Math.random().toString(36).slice(2);
  private fields = {} as Record<FieldName, HTMLInputElement | HTMLTextAreaElement>;
  private draftInput!: HTMLInputElement;
  private photosEl!: HTMLElement;
  private postsEl!: HTMLElement;
  private selectedPostsEl!: HTMLElement;
  private postSearchInput!: HTMLInputElement;
  private fileNameButton!: HTMLButtonElement;
  private saveButton!: HTMLButtonElement;
  private headingTitleEl!: HTMLHeadingElement;
  private searchResultsEl!: HTMLElement;
  private saving = false;
  private draggedPhoto = -1;

  constructor(leaf: WorkspaceLeaf, plugin: FootprintStudioPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.allowNoFile = true;
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.currentFile?.basename ?? "新建足迹";
  }

  getIcon(): string {
    return "map-pinned";
  }

  getEditingPath(): string | null {
    return this.currentFile?.path ?? null;
  }

  requestSave(): void {
    if (this.saveButton) void this.saveFootprint(this.saveButton);
  }

  getState(): Record<string, unknown> {
    return super.getState();
  }

  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const filePath =
      state && typeof state === "object" && ("file" in state || "filePath" in state)
        ? String(
            (state as { file?: unknown; filePath?: unknown }).file ??
              (state as { filePath?: unknown }).filePath ??
              ""
          )
        : "";
    if (filePath) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) {
        await super.setState({ file: null }, result);
        this.resetForm();
        new Notice(`原足迹文件不存在：${filePath}`);
        return;
      }
    }
    await super.setState({ file: filePath || null }, result);
  }

  async onLoadFile(file: TFile): Promise<void> {
    await this.openFile(file);
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    this.resetForm();
  }

  async onOpen(): Promise<void> {
    await this.renderView();
  }

  async onClose(): Promise<void> {
    this.disposePhotos();
    this.mapResizeObserver?.disconnect();
    this.mapResizeObserver = null;
    if (this.mapResizeFrame) window.cancelAnimationFrame(this.mapResizeFrame);
    this.mapResizeFrame = 0;
    this.map?.remove();
    this.map = null;
    this.resetMapButton = null;
  }

  async openFile(file: TFile | null): Promise<void> {
    if (!this.fields.visitedAt) await this.renderView();
    this.resetForm(false);
    if (!file) return;

    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = asRecord(cache?.frontmatter as unknown);
    if (!frontmatter) {
      new Notice("没有读取到这篇足迹的 frontmatter");
      return;
    }

    this.currentFile = file;
    this.refreshTitle();
    this.fields.fileName.value = file.basename;
    this.fields.fileName.disabled = false;
    this.fileNameButton.disabled = false;
    this.fields.visitedAt.value = dateString(frontmatter.visitedAt);
    this.fields.capturedTime.value = timeString(frontmatter.capturedAt);
    this.fields.country.value = String(frontmatter.country ?? "");
    this.fields.region.value = String(frontmatter.region ?? "");
    this.fields.city.value = String(frontmatter.city ?? "");
    this.fields.district.value = String(frontmatter.district ?? "");
    this.fields.town.value = String(frontmatter.town ?? "");
    this.fields.street.value = String(frontmatter.street ?? "");
    this.fields.place.value = String(frontmatter.place ?? "");
    const coordinates = asRecord(frontmatter.coordinates);
    this.fields.lat.value = String(coordinates?.lat ?? "");
    this.fields.lng.value = String(coordinates?.lng ?? "");
    const savedLat = Number(coordinates?.lat);
    const savedLng = Number(coordinates?.lng);
    this.savedCoordinates =
      Number.isFinite(savedLat) && Number.isFinite(savedLng)
        ? { lat: savedLat, lng: savedLng }
        : null;
    this.updateResetMapButton();
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
      (value: unknown, index: number) => {
        const photo = asRecord(value) ?? {};
        const source = String(photo.src ?? "");
        const linked = this.app.metadataCache.getFirstLinkpathDest(source, file.path);
        return {
          id: `existing-${index}-${Date.now()}`,
          source,
          previewUrl:
            linked instanceof TFile ? this.app.vault.getResourcePath(linked) : "",
          alt: String(photo.alt ?? ""),
          caption: String(photo.caption ?? ""),
          position: String(photo.position ?? "center") || "center",
          hidden: Boolean(photo.hidden),
          coordinates: (() => {
            const coordinates = asRecord(photo.coordinates);
            const lat = Number(coordinates?.lat);
            const lng = Number(coordinates?.lng);
            return Number.isFinite(lat) && Number.isFinite(lng)
              ? { lat, lng }
              : null;
          })(),
          capturedAt: dateTimeString(photo.capturedAt),
          metadataPending: false,
        };
      }
    );

    this.renderPhotos();
    this.renderSelectedPosts();
    this.renderPostSuggestions();
    this.updateMarker(true);
    this.app.workspace.trigger("layout-change");
    this.app.workspace.requestSaveLayout();
  }

  private async renderView(): Promise<void> {
    this.mapResizeObserver?.disconnect();
    this.mapResizeObserver = null;
    if (this.mapResizeFrame) window.cancelAnimationFrame(this.mapResizeFrame);
    this.mapResizeFrame = 0;
    this.contentEl.empty();
    this.contentEl.addClass("footprint-studio-view");

    const header = this.contentEl.createDiv({ cls: "footprint-studio-header" });
    const heading = header.createDiv({ cls: "footprint-studio-heading" });
    this.headingTitleEl = heading.createEl("h2", { text: this.getDisplayText() });
    const actions = header.createDiv({ cls: "footprint-studio-header-actions" });
    const resetButton = makeButton(actions, "新建足迹", "file-plus-2");
    resetButton.addEventListener("click", () => void this.plugin.openStudio());
    this.saveButton = makeButton(actions, "保存足迹", "save", "mod-cta");
    this.saveButton.setAttribute("title", "保存足迹");
    this.saveButton.addEventListener("click", () => this.requestSave());

    const workspace = this.contentEl.createDiv({ cls: "footprint-studio-workspace" });
    const photoPanel = workspace.createDiv({
      cls: "footprint-studio-form footprint-studio-photo-panel",
    });
    this.renderPhotoSection(photoPanel);

    const mapPanel = workspace.createDiv({ cls: "footprint-studio-map-panel" });
    applyMapHeightClass(mapPanel, this.plugin.settings.mapHeight);
    const mapHost = mapPanel.createDiv({ cls: "footprint-studio-map-host" });
    this.renderMapToolbar(mapHost);
    const mapEl = mapHost.createDiv({ cls: "footprint-studio-map" });
    mapEl.setAttribute("aria-label", "足迹坐标选择地图");
    this.searchResultsEl = mapHost.createDiv({
      cls: "footprint-studio-search-results",
    });
    this.searchResultsEl.hidden = true;
    const mapFields = mapPanel.createDiv({ cls: "footprint-studio-map-fields" });
    this.renderMapFields(mapFields);
    for (const eventName of ["pointerdown", "click", "dblclick"]) {
      mapFields.addEventListener(eventName, event => event.stopPropagation());
    }
    mapFields.addEventListener(
      "wheel",
      event => event.stopPropagation(),
      { passive: true }
    );
    const form = workspace.createDiv({
      cls: "footprint-studio-form footprint-studio-details-form",
    });
    this.renderBasicFields(form);
    this.renderRelatedSection(form);
    this.renderDescriptionSection(form);

    this.blogPosts = await this.loadBlogPosts();
    this.resetForm();

    window.requestAnimationFrame(() => {
      this.map?.remove();
      this.resetMapButton = null;
      this.map = L.map(mapEl, {
        zoomControl: false,
        scrollWheelZoom: true,
        attributionControl: true,
      }).setView(
        [this.plugin.settings.defaultLat, this.plugin.settings.defaultLng],
        this.plugin.settings.defaultZoom
      );
      const zoomControl = L.control
        .zoom({ position: "bottomleft" })
        .addTo(this.map)
        .getContainer();
      if (zoomControl) {
        const addMapAction = (
          className: string,
          label: string,
          icon: string,
          action: () => void
        ) => {
          const button = zoomControl.createEl("a", {
            cls: className,
            attr: { href: "#", role: "button", "aria-label": label, title: label },
          });
          setIcon(button, icon);
          button.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            action();
          });
          return button;
        };
        addMapAction(
          "footprint-studio-map-center-control",
          "回到当前标记",
          "locate-fixed",
          () => this.centerCurrentMarker()
        );
        this.resetMapButton = addMapAction(
          "footprint-studio-map-reset-control",
          "恢复已保存坐标",
          "rotate-ccw",
          () => this.resetSavedMarker()
        );
        this.updateResetMapButton();
      }
      L.tileLayer(this.plugin.settings.tileUrl, {
        maxZoom: 19,
        attribution: "© OpenStreetMap contributors",
      }).addTo(this.map);
      this.map.on("click", event => {
        this.setCoordinates(event.latlng.lat, event.latlng.lng, false);
      });
      this.mapResizeObserver = new ResizeObserver(() => {
        if (this.mapResizeFrame) window.cancelAnimationFrame(this.mapResizeFrame);
        this.mapResizeFrame = window.requestAnimationFrame(() => {
          this.mapResizeFrame = 0;
          this.map?.invalidateSize({ pan: false, debounceMoveend: true });
        });
      });
      this.mapResizeObserver.observe(mapHost);
      window.setTimeout(() => this.map?.invalidateSize(), 0);
    });
  }

  private renderMapToolbar(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: "footprint-studio-map-toolbar" });
    const searchControl = toolbar.createDiv({
      cls: "footprint-studio-map-search-control",
    });
    const searchInput = searchControl.createEl("input", {
      type: "search",
      placeholder: "搜索城市或景点",
      attr: { "aria-label": "搜索地图地点" },
    });
    const searchButton = makeButton(
      searchControl,
      "",
      "search",
      "footprint-studio-map-search-button"
    );
    searchButton.setAttribute("aria-label", "搜索地图地点");
    searchButton.setAttribute("title", "搜索");
    const reverseButton = makeButton(
      toolbar,
      "补全地点",
      "map-pin-check",
      "footprint-studio-map-geocode-button"
    );
    reverseButton.setAttribute("title", "根据当前坐标补全地点");
    reverseButton.addEventListener("click", () => void this.reverseGeocode());
    const runSearch = () => void this.searchPlace(searchInput.value);
    searchButton.addEventListener("click", runSearch);
    searchInput.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch();
      }
    });
  }

  setMapHeight(height: number): void {
    const mapPanel = this.contentEl.querySelector<HTMLElement>(
      ".footprint-studio-map-panel"
    );
    if (mapPanel) applyMapHeightClass(mapPanel, height);
    window.requestAnimationFrame(() =>
      this.map?.invalidateSize({ pan: false })
    );
  }

  private renderBasicFields(parent: HTMLElement): void {
    const grid = parent.createDiv({ cls: "footprint-studio-field-grid" });
    this.fields.fileName = this.createInput(grid, "文件名", "fileName", "例如 2026-07-17-panmen");
    const fileNameControl = createDiv({
      cls: "footprint-studio-file-name-control",
    });
    this.fields.fileName.replaceWith(fileNameControl);
    fileNameControl.append(this.fields.fileName);
    this.fileNameButton = makeButton(
      fileNameControl,
      "生成",
      "wand-sparkles",
      "footprint-studio-generate-name"
    );
    this.fileNameButton.addEventListener("click", () => this.generateFileName());
    const draftLabel = parent.createEl("label", { cls: "footprint-studio-toggle" });
    this.draftInput = draftLabel.createEl("input", { type: "checkbox" });
    draftLabel.createSpan({ text: "保存为草稿（网站不会展示）" });
  }

  private renderMapFields(parent: HTMLElement): void {
    this.fields.visitedAt = this.createInput(
      parent,
      "拍摄日期",
      "visitedAt",
      "",
      "date"
    );
    this.fields.capturedTime = this.createInput(
      parent,
      "拍摄时间",
      "capturedTime",
      "",
      "time"
    );
    this.fields.capturedTime.setAttribute("step", "1");
    this.fields.lat = this.createInput(
      parent,
      "纬度",
      "lat",
      "31.2883",
      "number"
    );
    this.fields.lng = this.createInput(
      parent,
      "经度",
      "lng",
      "120.6183",
      "number"
    );
    this.fields.country = this.createInput(parent, "国家", "country", "中国");
    this.fields.region = this.createInput(parent, "省 / 地区", "region", "江苏");
    this.fields.city = this.createInput(parent, "城市", "city", "苏州");
    this.fields.district = this.createInput(parent, "区 / 县", "district", "姑苏区");
    this.fields.town = this.createInput(parent, "乡镇 / 街道", "town", "沧浪街道");
    this.fields.street = this.createInput(parent, "道路 / 门牌", "street", "东大街 49 号");
    this.fields.place = this.createInput(parent, "具体地点", "place", "盘门");
    this.fields.lat.setAttribute("step", "any");
    this.fields.lng.setAttribute("step", "any");
    for (const name of ["lat", "lng"] as FieldName[]) {
      this.fields[name].addEventListener("change", () => this.updateMarker(false));
    }
  }

  private renderRelatedSection(parent: HTMLElement): void {
    const inputId = `footprint-studio-post-search-${this.instanceId}`;
    const field = parent.createDiv({ cls: "footprint-studio-details-field" });
    field.createEl("label", {
      cls: "footprint-studio-details-label",
      text: "关联文章",
      attr: { for: inputId },
    });
    const control = field.createDiv({ cls: "footprint-studio-related-control" });
    this.selectedPostsEl = control.createDiv({ cls: "footprint-studio-selected-posts" });
    this.postSearchInput = control.createEl("input", {
      type: "search",
      placeholder: "输入标题、slug 或关键词搜索文章",
      cls: "footprint-studio-post-search",
      attr: { id: inputId, autocomplete: "off" },
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
    section.addClass("footprint-studio-photo-section");
    const intro = section.createDiv({ cls: "footprint-studio-photo-intro" });
    intro.createEl("p", {
      text: "选择或直接拖入照片；添加后可拖动排序。",
    });
    const picker = makeButton(intro, "选择图片", "image-plus", "mod-cta");
    const input = section.createEl("input", {
      attr: { type: "file", accept: "image/*", multiple: true },
    });
    input.hidden = true;
    input.addEventListener("change", () => {
      this.addPhotoFiles(Array.from(input.files ?? []));
      input.value = "";
    });
    picker.addEventListener("click", () => input.click());
    this.photosEl = section.createDiv({ cls: "footprint-studio-photo-grid" });

    const containsFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    section.addEventListener("dragenter", event => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      section.addClass("is-file-dragging");
    });
    section.addEventListener("dragover", event => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      section.addClass("is-file-dragging");
    });
    section.addEventListener("dragleave", event => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && section.contains(nextTarget)) return;
      section.removeClass("is-file-dragging");
    });
    section.addEventListener("drop", event => {
      if (!containsFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      section.removeClass("is-file-dragging");
      this.addPhotoFiles(Array.from(event.dataTransfer?.files ?? []));
    });
  }

  private renderDescriptionSection(parent: HTMLElement): void {
    const inputId = `footprint-studio-description-${this.instanceId}`;
    const field = parent.createDiv({ cls: "footprint-studio-details-field" });
    field.createEl("label", {
      cls: "footprint-studio-details-label",
      text: "文字记录",
      attr: { for: inputId },
    });
    this.fields.description = field.createEl("textarea", {
      cls: "footprint-studio-description",
      placeholder: "写下当时看到的光、天气或心情……",
      attr: { id: inputId, rows: "7" },
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
    wrapper.dataset.field = name;
    wrapper.createSpan({ text: label });
    const input = wrapper.createEl("input", {
      type,
      placeholder,
      attr: { name },
    });
    return input;
  }

  private resetForm(clearCurrentFile = true): void {
    if (clearCurrentFile) this.currentFile = null;
    this.savedCoordinates = null;
    this.updateResetMapButton();
    this.refreshTitle();
    this.disposePhotos();
    this.photos = [];
    this.pendingPhotoDeletes.clear();
    this.selectedPosts.clear();
    if (!this.fields.visitedAt) return;

    for (const field of Object.values(this.fields)) field.value = "";
    this.fields.fileName.disabled = false;
    this.fileNameButton.disabled = false;
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
  }

  private generateFileName(): void {
    const visitedAt = this.fields.visitedAt.value || todayString();
    const place = this.fields.place.value.trim();
    if (!place) {
      new Notice("请先填写地点，再生成文件名");
      this.fields.place.focus();
      return;
    }
    const placePinyin = placePinyinSegment(place);
    if (!placePinyin) {
      new Notice("地点无法生成拼音，请手动填写文件名");
      this.fields.fileName.focus();
      return;
    }
    this.fields.fileName.value = sanitizeSegment(`${visitedAt}-${placePinyin}`);
  }

  private setCoordinates(lat: number, lng: number, moveMap: boolean): void {
    this.fields.lat.value = lat.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    this.fields.lng.value = lng.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    this.updateMarker(moveMap);
  }

  private updateMarker(moveMap: boolean): void {
    if (!this.map) {
      window.setTimeout(() => this.updateMarker(moveMap), 50);
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
        url: `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(text)}`,
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
          this.applyAddress(result.address ?? {}, result.name, result.display_name);
          this.searchResultsEl.hidden = true;
        });
      }
    } catch (error) {
      console.error("Footprint Studio search failed", error);
      this.searchResultsEl.empty();
      this.searchResultsEl.createDiv({ text: "搜索失败，请检查网络后重试" });
    }
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
      this.applyAddress(result.address ?? {}, result.name, result.display_name);
      new Notice("已根据新坐标更新省、市、区和地点信息");
    } catch (error) {
      console.error("Footprint Studio reverse geocoding failed", error);
      new Notice("地点反查失败，请手动填写或稍后重试");
    }
  }

  private centerCurrentMarker(): void {
    const lat = Number(this.fields.lat.value);
    const lng = Number(this.fields.lng.value);
    if (!this.map || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      new Notice("请先在地图上选择坐标");
      return;
    }
    this.map.setView([lat, lng], Math.max(this.map.getZoom(), 15), {
      animate: true,
    });
  }

  private resetSavedMarker(): void {
    if (!this.savedCoordinates) {
      new Notice("当前足迹还没有已保存的坐标");
      return;
    }
    this.setCoordinates(
      this.savedCoordinates.lat,
      this.savedCoordinates.lng,
      true
    );
  }

  private updateResetMapButton(): void {
    if (!this.resetMapButton) return;
    const disabled = !this.savedCoordinates;
    this.resetMapButton.setAttribute("aria-disabled", String(disabled));
    if (disabled) this.resetMapButton.addClass("is-disabled");
    else this.resetMapButton.removeClass("is-disabled");
  }

  private applyAddress(
    address: NominatimAddress,
    name?: string,
    displayName = ""
  ): void {
    const displayParts = displayName
      .split(",")
      .map(part => part.trim())
      .filter(Boolean);
    const isDistrictLevel = (value: string): boolean =>
      /(?:区|县|旗|镇|乡|街道|村)$/.test(value);
    const isCityLevel = (value: string): boolean =>
      /(?:市|自治州|地区|盟)$/.test(value) && !isDistrictLevel(value);
    const cityCandidates = [
      address.city,
      ...displayParts.filter(isCityLevel),
      address.municipality,
      address.state_district,
      address.county,
      address.state,
    ]
      .map(value => String(value ?? "").trim())
      .filter(value => value && !isDistrictLevel(value));
    const rawAddressCity = String(address.city ?? "").trim();
    const city =
      cityCandidates.find(isCityLevel) ??
      (rawAddressCity && !isDistrictLevel(rawAddressCity) ? rawAddressCity : "");
    const districtCandidates = [
      address.city_district,
      address.district,
      address.county,
      address.borough,
      ...displayParts.filter(part => /(?:区|县|旗)$/.test(part)),
    ]
      .map(value => String(value ?? "").trim())
      .filter(value => value && value !== city);
    const district = districtCandidates[0] ?? "";
    const town =
      address.town ??
      address.township ??
      address.village ??
      address.hamlet ??
      address.suburb;
    const streetName = address.road ?? address.pedestrian ?? address.residential;
    const street = [streetName, address.house_number].filter(Boolean).join(" ");
    this.fields.country.value = address.country ?? "";
    this.fields.region.value = address.state ?? address.province ?? "";
    this.fields.city.value = city;
    this.fields.district.value = district;
    this.fields.town.value = town ?? "";
    this.fields.street.value = street;

    const administrativeValues = new Set(
      [
        this.fields.country.value,
        this.fields.region.value,
        this.fields.city.value,
        address.city,
        address.municipality,
        address.county,
        district,
        town,
        street,
      ]
        .filter(Boolean)
        .map(value => String(value).trim())
    );
    const placeParts = [
      name,
      address.tourism,
      address.historic,
      address.amenity,
      address.neighbourhood,
      address.quarter,
    ]
      .map(value => String(value ?? "").trim())
      .filter(value => value && !administrativeValues.has(value))
      .filter((value, index, values) => values.indexOf(value) === index);

    this.fields.place.value = placeParts.join(" · ");
  }

  private addPhotoFiles(files: File[]): void {
    const imageFiles = files.filter(
      file =>
        file.type.startsWith("image/") || /\.(?:jpe?g|tiff?)$/i.test(file.name)
    );
    const addedPhotos: PhotoDraft[] = [];
    for (const file of imageFiles) {
      const fallbackAlt = baseName(file.name).replace(/[-_]+/g, " ");
      const photo: PhotoDraft = {
        id: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: URL.createObjectURL(file),
        alt: this.fields.place.value.trim() || fallbackAlt,
        caption: "",
        position: "center",
        hidden: false,
        coordinates: null,
        capturedAt: "",
        metadataPending: true,
      };
      this.photos.push(photo);
      addedPhotos.push(photo);
    }
    this.renderPhotos();
    void Promise.all(
      addedPhotos.map(photo => this.loadPhotoMetadata(photo, false))
    ).then(() => this.renderPhotos());
  }

  private async readPhotoMetadata(photo: PhotoDraft): Promise<PhotoExifMetadata | null> {
    let buffer: ArrayBuffer | null = null;
    if (photo.file) {
      buffer = await photo.file.arrayBuffer();
    } else if (photo.source && this.currentFile) {
      const linked = this.app.metadataCache.getFirstLinkpathDest(
        photo.source,
        this.currentFile.path
      );
      if (linked instanceof TFile) buffer = await this.app.vault.readBinary(linked);
    }
    return buffer ? extractPhotoMetadata(buffer) : null;
  }

  private async loadPhotoMetadata(
    photo: PhotoDraft,
    renderAfter = true
  ): Promise<void> {
    try {
      const metadata = await this.readPhotoMetadata(photo);
      photo.coordinates = metadata?.coordinates ?? null;
      photo.capturedAt = metadata?.capturedAt ?? "";
    } catch (error) {
      console.warn("Footprint Studio 自动读取照片信息失败", error);
      photo.coordinates = null;
      photo.capturedAt = "";
    } finally {
      photo.metadataPending = false;
      if (renderAfter) this.renderPhotos();
    }
  }

  private async applyPhotoMetadata(
    photo: PhotoDraft,
    button: HTMLButtonElement
  ): Promise<void> {
    button.disabled = true;
    button.addClass("is-loading");
    try {
      const metadata = await this.readPhotoMetadata(photo);
      if (!metadata) {
        new Notice("这张照片没有可读取的拍摄坐标或时间");
        return;
      }
      photo.coordinates = metadata.coordinates;
      photo.capturedAt = metadata.capturedAt ?? "";
      if (metadata.coordinates) {
        this.setCoordinates(metadata.coordinates.lat, metadata.coordinates.lng, true);
      }
      if (metadata.capturedAt) {
        this.fields.visitedAt.value = metadata.capturedAt.slice(0, 10);
        this.fields.capturedTime.value = metadata.capturedAt.slice(11, 19);
      }
      if (metadata.coordinates && metadata.capturedAt) {
        new Notice("已更新地图坐标、拍摄日期和时间");
      } else if (metadata.coordinates) {
        new Notice("已更新地图坐标；未读取到拍摄时间");
      } else {
        new Notice("已更新拍摄日期和时间；照片没有 GPS 坐标");
      }
      this.renderPhotos();
    } catch (error) {
      console.error("Footprint Studio 读取照片信息失败", error);
      new Notice("读取照片信息失败");
    } finally {
      button.disabled = false;
      button.removeClass("is-loading");
    }
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
      if (photo.hidden) card.addClass("is-hidden");
      card.draggable = true;
      card.addEventListener("dragstart", event => {
        this.draggedPhoto = index;
        card.addClass("is-dragging");
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("dragend", () => card.removeClass("is-dragging"));
      card.addEventListener("dragover", event => {
        if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
        event.preventDefault();
      });
      card.addEventListener("drop", event => {
        if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
        event.preventDefault();
        if (this.draggedPhoto < 0 || this.draggedPhoto === index) return;
        const [moved] = this.photos.splice(this.draggedPhoto, 1);
        this.photos.splice(index, 0, moved);
        this.draggedPhoto = -1;
        this.renderPhotos();
      });

      const preview = card.createDiv({ cls: "footprint-studio-photo-preview" });
      if (photo.previewUrl) {
        const previewLabel = photo.alt || `照片 ${index + 1}`;
        const openButton = preview.createEl("button", {
          cls: "footprint-studio-photo-open",
          attr: {
            type: "button",
            "aria-label": `放大查看${previewLabel}`,
          },
        });
        const image = openButton.createEl("img", {
          attr: {
            src: photo.previewUrl,
            alt: previewLabel,
            loading: "lazy",
            decoding: "async",
          },
        });
        image.draggable = false;
        const openPreview = () =>
          new PhotoPreviewModal(
            this.app,
            photo.previewUrl,
            previewLabel,
            photo.caption
          ).open();
        openButton.addEventListener("click", openPreview);
      } else {
        const missing = preview.createDiv({ cls: "footprint-studio-photo-missing" });
        setIcon(missing, "image-off");
        missing.createSpan({ text: "找不到原图" });
      }
      preview.createSpan({ cls: "footprint-studio-photo-index", text: String(index + 1) });

      const gps = makeButton(
        preview,
        "",
        "map-pin-check",
        "footprint-studio-photo-metadata"
      );
      gps.setAttribute("aria-label", "读取照片信息");
      gps.setAttribute("title", "读取照片信息");
      gps.addEventListener("pointerdown", event => event.stopPropagation());
      gps.addEventListener("click", () => void this.applyPhotoMetadata(photo, gps));

      const cardActions = preview.createDiv({ cls: "footprint-studio-photo-actions" });
      const visibility = makeButton(
        cardActions,
        "",
        photo.hidden ? "eye-off" : "eye"
      );
      const updateVisibility = () => {
        const label = photo.hidden ? "在网站显示这张照片" : "在网站隐藏这张照片";
        visibility.setAttribute("aria-label", label);
        visibility.setAttribute("title", label);
        visibility.setAttribute("aria-pressed", String(photo.hidden));
        const icon = visibility.querySelector<HTMLElement>(
          ".footprint-studio-button-icon"
        );
        if (icon) {
          icon.empty();
          setIcon(icon, photo.hidden ? "eye-off" : "eye");
        }
        if (photo.hidden) card.addClass("is-hidden");
        else card.removeClass("is-hidden");
      };
      updateVisibility();
      visibility.addEventListener("click", () => {
        photo.hidden = !photo.hidden;
        updateVisibility();
      });
      const up = makeButton(cardActions, "", "arrow-left");
      up.setAttribute("aria-label", "向前移动");
      up.disabled = index === 0;
      up.addEventListener("click", () => this.movePhoto(index, index - 1));
      const down = makeButton(cardActions, "", "arrow-right");
      down.setAttribute("aria-label", "向后移动");
      down.disabled = index === this.photos.length - 1;
      down.addEventListener("click", () => this.movePhoto(index, index + 1));
      const remove = makeButton(cardActions, "", "trash-2");
      remove.setAttribute("aria-label", "删除照片和文件");
      remove.setAttribute("title", "删除照片和文件");
      remove.addEventListener("click", () => this.removePhoto(index));

      const positionControl = preview.createDiv({
        cls: "footprint-studio-photo-position-control",
      });
      const positionLabels = new Map<string, string>([
        ["left top", "左上"],
        ["center top", "上方"],
        ["right top", "右上"],
        ["left center", "左侧"],
        ["center", "居中"],
        ["right center", "右侧"],
        ["left bottom", "左下"],
        ["center bottom", "下方"],
        ["right bottom", "右下"],
      ]);
      const positionButton = positionControl.createEl("button", {
        cls: "footprint-studio-photo-position-button",
        attr: { type: "button" },
      });
      const positionIndicator = positionButton.createSpan({
        cls: "footprint-studio-photo-position-indicator",
      });
      for (const position of positionLabels.keys()) {
        const anchor = positionIndicator.createSpan({
          cls: "footprint-studio-photo-position-anchor",
        });
        anchor.dataset.position = position;
      }
      const positionMenu = positionControl.createDiv({
        cls: "footprint-studio-photo-position-menu",
        attr: { role: "menu", "aria-label": "选择缩略图裁剪焦点" },
      });
      positionMenu.hidden = true;
      const refreshPosition = () => {
        const label = positionLabels.get(photo.position) ?? photo.position ?? "居中";
        positionButton.setAttribute("aria-label", `裁剪焦点：${label}`);
        positionButton.setAttribute("title", `裁剪焦点：${label}`);
        const visiblePosition = positionLabels.has(photo.position)
          ? photo.position
          : "center";
        for (const anchor of positionIndicator.querySelectorAll<HTMLElement>(
          ".footprint-studio-photo-position-anchor"
        )) {
          if (anchor.dataset.position === visiblePosition) anchor.addClass("is-active");
          else anchor.removeClass("is-active");
        }
        for (const option of positionMenu.querySelectorAll<HTMLElement>("button")) {
          const selected = option.dataset.position === photo.position;
          option.setAttribute("aria-checked", String(selected));
          if (selected) option.addClass("is-selected");
          else option.removeClass("is-selected");
        }
      };
      for (const [position, label] of positionLabels) {
        const option = positionMenu.createEl("button", {
          cls: "footprint-studio-photo-position-option",
          attr: {
            type: "button",
            role: "menuitemradio",
            "aria-label": label,
            title: label,
          },
        });
        option.dataset.position = position;
        option.createSpan({ cls: "footprint-studio-photo-position-dot" });
        option.addEventListener("click", () => {
          photo.position = position;
          positionMenu.hidden = true;
          positionButton.setAttribute("aria-expanded", "false");
          refreshPosition();
          positionButton.focus();
        });
      }
      refreshPosition();
      positionButton.setAttribute("aria-haspopup", "menu");
      positionButton.setAttribute("aria-expanded", "false");
      positionButton.addEventListener("click", () => {
        positionMenu.hidden = !positionMenu.hidden;
        positionButton.setAttribute("aria-expanded", String(!positionMenu.hidden));
      });
      positionControl.addEventListener("pointerdown", event => event.stopPropagation());
      positionControl.addEventListener("focusout", () => {
        window.setTimeout(() => {
          if (!positionControl.contains(document.activeElement)) {
            positionMenu.hidden = true;
            positionButton.setAttribute("aria-expanded", "false");
          }
        }, 0);
      });

      const copy = preview.createDiv({ cls: "footprint-studio-photo-copy" });
      const copyPreview = copy.createEl("button", {
        cls: "footprint-studio-photo-copy-preview",
        attr: {
          type: "button",
          "aria-label": "编辑照片文字",
          "aria-haspopup": "dialog",
          "aria-expanded": "false",
        },
      });
      const altText = copyPreview.createSpan({
        cls: "footprint-studio-photo-alt-text",
      });
      const captionText = copyPreview.createSpan({
        cls: "footprint-studio-photo-caption-text",
      });
      const metadataText = copyPreview.createSpan({
        cls: "footprint-studio-photo-exif",
      });
      const capturedAtText = metadataText.createSpan();
      const coordinatesText = metadataText.createSpan();
      const editor = copy.createDiv({ cls: "footprint-studio-photo-editor" });
      editor.hidden = true;
      const alt = this.createCompactInput(editor, "替代文本", photo.alt);
      const caption = this.createCompactInput(editor, "图片说明（可选）", photo.caption);
      const setCopyEditorOpen = (open: boolean, focusInput = false) => {
        editor.hidden = !open;
        copyPreview.setAttribute("aria-expanded", String(open));
        // A draggable ancestor takes over pointer movement before the browser can
        // create a text selection. Suspend card sorting for the whole editing
        // session, then restore it when the popover closes.
        card.draggable = !open;
        if (open && focusInput) alt.focus();
      };
      const refreshCopy = () => {
        altText.textContent = photo.alt.trim() || "添加替代文本";
        captionText.textContent = photo.caption.trim();
        captionText.hidden = !photo.caption.trim();
        capturedAtText.textContent = photo.capturedAt
          ? photo.capturedAt.replace("T", " ")
          : "";
        capturedAtText.hidden = !photo.capturedAt;
        coordinatesText.textContent = photo.coordinates
          ? `${photo.coordinates.lat.toFixed(5)}, ${photo.coordinates.lng.toFixed(5)}`
          : "";
        coordinatesText.hidden = !photo.coordinates;
        metadataText.hidden =
          !photo.metadataPending && !photo.capturedAt && !photo.coordinates;
        if (photo.metadataPending) {
          capturedAtText.textContent = "正在读取拍摄信息…";
          capturedAtText.hidden = false;
          coordinatesText.hidden = true;
        }
      };
      alt.addEventListener("input", () => {
        photo.alt = alt.value;
        refreshCopy();
      });
      caption.addEventListener("input", () => {
        photo.caption = caption.value;
        refreshCopy();
      });
      refreshCopy();
      copyPreview.addEventListener("click", () => {
        setCopyEditorOpen(editor.hidden, true);
      });
      copy.addEventListener("pointerdown", event => event.stopPropagation());
      editor.addEventListener("dragstart", event => {
        event.preventDefault();
        event.stopPropagation();
      });
      copy.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;
        setCopyEditorOpen(false);
        copyPreview.focus();
      });
      copy.addEventListener("focusout", () => {
        window.setTimeout(() => {
          if (!copy.contains(document.activeElement)) {
            setCopyEditorOpen(false);
          }
        }, 0);
      });
    });
  }

  private createCompactInput(parent: HTMLElement, placeholder: string, value: string): HTMLInputElement {
    const input = parent.createEl("input", { type: "text", placeholder });
    input.value = value;
    input.addEventListener("pointerdown", event => event.stopPropagation());
    input.addEventListener("dragstart", event => {
      event.preventDefault();
      event.stopPropagation();
    });
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
    const linkedFile = photo ? this.resolvePhotoFile(photo) : null;
    if (
      linkedFile &&
      this.isManagedPhotoFile(linkedFile) &&
      !this.photos.some(item => this.resolvePhotoFile(item)?.path === linkedFile.path)
    ) {
      this.pendingPhotoDeletes.add(linkedFile.path);
      new Notice("照片将在保存足迹后移入回收站");
    } else if (linkedFile && !this.isManagedPhotoFile(linkedFile)) {
      new Notice("已移除照片引用；外部图片文件不会被删除");
    }
    if (photo?.file && photo.previewUrl.startsWith("blob:")) URL.revokeObjectURL(photo.previewUrl);
    this.renderPhotos();
  }

  private resolvePhotoFile(photo: PhotoDraft): TFile | null {
    if (!photo.source || !this.currentFile) return null;
    const linked = this.app.metadataCache.getFirstLinkpathDest(
      photo.source,
      this.currentFile.path
    );
    return linked instanceof TFile ? linked : null;
  }

  private isManagedPhotoFile(file: TFile): boolean {
    const folder = normalizePath(this.plugin.settings.attachmentsFolder).replace(
      /\/+$/,
      ""
    );
    return Boolean(folder) && file.path.startsWith(`${folder}/`);
  }

  private async trashPendingPhotoFiles(): Promise<void> {
    const parentFolders = new Set<string>();
    for (const path of [...this.pendingPhotoDeletes]) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        if (file.parent?.path) parentFolders.add(file.parent.path);
        await this.app.fileManager.trashFile(file);
      }
      this.pendingPhotoDeletes.delete(path);
    }
    const attachmentsRoot = normalizePath(
      this.plugin.settings.attachmentsFolder
    );
    for (const folderPath of parentFolders) {
      if (folderPath === attachmentsRoot) continue;
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (folder instanceof TFolder && folder.children.length === 0) {
        await this.app.fileManager.trashFile(folder);
      }
    }
  }

  private disposePhotos(): void {
    for (const photo of this.photos) {
      if (photo.file && photo.previewUrl.startsWith("blob:")) URL.revokeObjectURL(photo.previewUrl);
    }
  }

  private async loadBlogPosts(): Promise<BlogPostOption[]> {
    const prefix = `${normalizePath(this.plugin.settings.blogFolder)}/`;
    const files = this.app.vault.getFiles().filter(file => {
      const extension = file.extension.toLowerCase();
      return file.path.startsWith(prefix) && (extension === "md" || extension === "mdx");
    });
    const posts = await Promise.all(
      files.map(async file => {
        let frontmatter = asRecord(
          this.app.metadataCache.getFileCache(file)?.frontmatter as unknown
        );
        if (!frontmatter) {
          try {
            const source = await this.app.vault.cachedRead(file);
            const match = source.match(
              /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
            );
            const parsed: unknown = match ? parseYaml(match[1]) : null;
            frontmatter = asRecord(parsed);
          } catch (error) {
            console.warn(`Footprint Studio 无法解析文章 frontmatter：${file.path}`, error);
          }
        }
        const slug = String(frontmatter?.slug ?? "").trim() || file.basename;
        const title = String(frontmatter?.title ?? "").trim() || file.basename;
        const rawKeywords = frontmatter?.keywords;
        const keywords = (
          Array.isArray(rawKeywords)
            ? rawKeywords
            : rawKeywords == null
              ? []
              : [rawKeywords]
        )
          .map(value => String(value).trim())
          .filter(Boolean);
        return { id: slug, title, path: file.path, keywords };
      })
    );
    return posts.sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
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
    const query = this.postSearchInput.value.trim();
    const normalizedQuery = normalizeSearchText(query);
    if (!normalizedQuery) {
      this.postsEl.hidden = true;
      return;
    }
    const posts = this.blogPosts
      .filter(
        post =>
          !this.selectedPosts.has(post.id) &&
          `${post.title} ${post.id} ${post.keywords.join(" ")}`
            .toLocaleLowerCase("zh-CN")
            .includes(normalizedQuery)
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
      const text = button.createDiv({ cls: "footprint-studio-post-copy" });
      const title = text.createEl("strong", {
        cls: "footprint-studio-post-title",
      });
      appendHighlightedText(title, post.title, normalizedQuery);
      const slug = text.createEl("span", {
        cls: "footprint-studio-post-slug",
      });
      appendHighlightedText(slug, post.id, normalizedQuery);

      const matchingKeywords = post.keywords.filter(keyword =>
        normalizeSearchText(keyword).includes(normalizedQuery)
      );
      if (matchingKeywords.length) {
        const keywords = text.createDiv({ cls: "footprint-studio-post-keywords" });
        keywords.createSpan({
          cls: "footprint-studio-post-keywords-label",
          text: "关键词",
        });
        for (const keyword of matchingKeywords) {
          const keywordEl = keywords.createSpan({
            cls: "footprint-studio-post-keyword",
          });
          appendHighlightedText(keywordEl, keyword, normalizedQuery);
        }
      }
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
    if (!this.photos.some(photo => !photo.hidden)) {
      new Notice("请至少保留一张在网站展示的照片");
      return;
    }

    this.saving = true;
    button.disabled = true;
    button.addClass("is-loading");
    try {
      const fileName = sanitizeSegment(
        values.fileName.replace(/\.md$/i, "")
      );
      const markdownFolder = this.currentFile
        ? this.currentFile.path.split("/").slice(0, -1).join("/")
        : normalizePath(this.plugin.settings.footprintsFolder);
      const markdownPath = normalizePath(`${markdownFolder}/${fileName}.md`);
      const pathOccupant = this.app.vault.getAbstractFileByPath(markdownPath);
      if (pathOccupant && pathOccupant.path !== this.currentFile?.path) {
        new Notice("同名足迹已经存在，请修改文件名");
        return;
      }

      const assetFolder = normalizePath(`${this.plugin.settings.attachmentsFolder}/${fileName}`);
      await this.trashPendingPhotoFiles();
      await this.rehomeSavedPhotos(markdownPath, assetFolder);
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

      let savedFile: TFile;
      if (this.currentFile) {
        if (this.currentFile.path !== markdownPath) {
          await this.app.vault.rename(this.currentFile, markdownPath);
        }
        const renamedFile = this.app.vault.getAbstractFileByPath(markdownPath);
        savedFile = renamedFile instanceof TFile ? renamedFile : this.currentFile;
      } else {
        await this.ensureFolder(normalizePath(this.plugin.settings.footprintsFolder));
        savedFile = await this.app.vault.create(markdownPath, "");
      }
      await this.writeFootprint(savedFile, values);
      this.currentFile = savedFile;
      this.savedCoordinates = { lat: values.lat, lng: values.lng };
      this.updateResetMapButton();
      this.refreshTitle();
      this.fields.fileName.value = savedFile.basename;
      this.fields.fileName.disabled = false;
      this.fileNameButton.disabled = false;
      this.renderPhotos();
      this.app.workspace.requestSaveLayout();
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
    capturedTime: string;
    country: string;
    region: string;
    city: string;
    district: string;
    town: string;
    street: string;
    place: string;
    lat: number;
    lng: number;
    description: string;
  } {
    return {
      fileName: this.fields.fileName.value.trim(),
      visitedAt: this.fields.visitedAt.value,
      capturedTime: this.fields.capturedTime.value,
      country: this.fields.country.value.trim(),
      region: this.fields.region.value.trim(),
      city: this.fields.city.value.trim(),
      district: this.fields.district.value.trim(),
      town: this.fields.town.value.trim(),
      street: this.fields.street.value.trim(),
      place: this.fields.place.value.trim(),
      lat: Number(this.fields.lat.value),
      lng: Number(this.fields.lng.value),
      description: this.fields.description.value.trim(),
    };
  }

  private async writeFootprint(
    file: TFile,
    values: ReturnType<FootprintStudioView["readValues"]>
  ): Promise<void> {
    await this.app.vault.process(file, current => {
      const frontmatter = getFrontMatterInfo(current);
      const body = values.description.trim();
      if (!frontmatter.exists) return body ? `${body}\n` : "";

      const frontmatterBlock = current
        .slice(0, frontmatter.contentStart)
        .trimEnd();
      return `${frontmatterBlock}\n\n${body}${body ? "\n" : ""}`;
    });

    await this.app.fileManager.processFrontMatter(
      file,
      (frontmatter: Record<string, unknown>) => {
        const setOptional = (key: string, value: string): void => {
          if (value) frontmatter[key] = value;
          else delete frontmatter[key];
        };

        frontmatter.visitedAt = values.visitedAt;
        setOptional(
          "capturedAt",
          values.capturedTime
            ? `${values.visitedAt}T${values.capturedTime}`
            : ""
        );
        frontmatter.country = values.country;
        frontmatter.region = values.region;
        frontmatter.city = values.city;
        setOptional("district", values.district);
        setOptional("town", values.town);
        setOptional("street", values.street);
        frontmatter.place = values.place;
        frontmatter.coordinates = { lat: values.lat, lng: values.lng };

        if (this.draftInput.checked) frontmatter.draft = true;
        else delete frontmatter.draft;

        if (this.selectedPosts.size) {
          frontmatter.relatedPosts = Array.from(this.selectedPosts);
        } else {
          delete frontmatter.relatedPosts;
        }

        frontmatter.photos = this.photos.flatMap(photo => {
          if (!photo.source) return [];
          const entry: Record<string, unknown> = {
            src: photo.source,
            alt: photo.alt.trim() || values.place,
          };
          if (photo.caption.trim()) entry.caption = photo.caption.trim();
          if (photo.position.trim()) entry.position = photo.position.trim();
          if (photo.hidden) entry.hidden = true;
          if (photo.capturedAt) entry.capturedAt = photo.capturedAt;
          if (photo.coordinates) {
            entry.coordinates = {
              lat: photo.coordinates.lat,
              lng: photo.coordinates.lng,
            };
          }
          return [entry];
        });
      }
    );
  }

  private refreshTitle(): void {
    const title = this.getDisplayText();
    if (this.headingTitleEl) this.headingTitleEl.textContent = title;
    const leaf = this.leaf as WorkspaceLeaf & { updateHeader?: () => void };
    leaf.updateHeader?.();
    this.app.workspace.trigger("layout-change");
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

  private async rehomeSavedPhotos(
    markdownPath: string,
    assetFolder: string
  ): Promise<void> {
    const entries = this.photos
      .filter(photo => !photo.file)
      .map(photo => {
        const file = this.resolvePhotoFile(photo);
        return file && this.isManagedPhotoFile(file)
          ? { photo, file, originalPath: file.path }
          : null;
      })
      .filter(
        (
          entry
        ): entry is { photo: PhotoDraft; file: TFile; originalPath: string } =>
          Boolean(entry)
      );
    if (!entries.length) return;

    const sourceFolders = new Set(
      entries
        .map(entry => entry.file.parent?.path ?? "")
        .filter(Boolean)
    );
    const targetExists = this.app.vault.getAbstractFileByPath(assetFolder);

    // The normal rename path: every saved photo lives in one per-footprint
    // folder and the destination does not exist yet. Renaming the folder keeps
    // any auxiliary files together and avoids unnecessary file-by-file moves.
    if (sourceFolders.size === 1 && !targetExists) {
      const [sourceFolderPath] = sourceFolders;
      const sourceFolder = this.app.vault.getAbstractFileByPath(sourceFolderPath);
      if (
        sourceFolder instanceof TFolder &&
        sourceFolder.path !== assetFolder &&
        sourceFolder.path !== normalizePath(this.plugin.settings.attachmentsFolder)
      ) {
        await this.app.vault.rename(sourceFolder, assetFolder);
        for (const entry of entries) {
          const movedPath = normalizePath(
            `${assetFolder}${entry.originalPath.slice(sourceFolderPath.length)}`
          );
          const movedFile = this.app.vault.getAbstractFileByPath(movedPath);
          entry.photo.source = relativePath(markdownPath, movedPath);
          entry.photo.previewUrl =
            movedFile instanceof TFile
              ? this.app.vault.getResourcePath(movedFile)
              : entry.photo.previewUrl;
        }
        return;
      }
    }

    // If a destination folder already exists (for example after an earlier
    // partial rename), merge only the referenced photos and resolve collisions.
    await this.ensureFolder(assetFolder);
    const previousFolders = new Set<string>();
    for (const entry of entries) {
      const parentPath = entry.file.parent?.path;
      if (parentPath) previousFolders.add(parentPath);
      let movedFile = entry.file;
      if (parentPath !== assetFolder) {
        const target = this.uniqueFilePath(assetFolder, entry.file.name);
        await this.app.vault.rename(entry.file, target);
        const resolved = this.app.vault.getAbstractFileByPath(target);
        if (resolved instanceof TFile) movedFile = resolved;
      }
      entry.photo.source = relativePath(markdownPath, movedFile.path);
      entry.photo.previewUrl = this.app.vault.getResourcePath(movedFile);
    }

    for (const folderPath of previousFolders) {
      if (
        folderPath === assetFolder ||
        folderPath === normalizePath(this.plugin.settings.attachmentsFolder)
      ) {
        continue;
      }
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (folder instanceof TFolder && folder.children.length === 0) {
        await this.app.fileManager.trashFile(folder);
      }
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
      .setName("地图高度")
      .setDesc("足迹编辑器中的地图高度，窄屏会自动限制在可视区域内。")
      .addSlider(slider =>
        slider
          .setLimits(MAP_HEIGHT_MIN, MAP_HEIGHT_MAX, 20)
          .setValue(this.plugin.settings.mapHeight)
          .onChange(async value => {
            this.plugin.settings.mapHeight = normalizeMapHeight(value);
            this.plugin.refreshMapHeights();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("默认缩放级别")
      .setDesc("建议使用 3–12。")
      .addSlider(slider =>
        slider
          .setLimits(2, 16, 1)
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
