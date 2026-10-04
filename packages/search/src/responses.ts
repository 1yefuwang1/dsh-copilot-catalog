import { searchError } from './errors.js';

/** Plain public result, with no opaque provider metadata. */
export interface NativeSearchResult {
  content?: string;
  sources: Array<{ url: string; title?: string; snippet?: string; publishedAt?: string }>;
  truncated: boolean;
}
// Bound structural expansion independently of wire bytes (especially sparse SSE indices).
const MAX_OUTPUT_ITEMS = 256;
const MAX_CONTENT_PARTS = 64;
const MAX_ANNOTATIONS = 256;
const MAX_ACTION_SOURCES = 2048;
const MAX_ITEM_ID_ALIASES = 4096;
type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid(): never { throw searchError('WEB_INVALID_RESPONSE'); }
function boundedArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) invalid();
  if (value.length > max) throw searchError('WEB_RESPONSE_TOO_LARGE');
  return value;
}
function validateItem(item: JsonObject): void {
  if (item.content !== undefined) boundedArray(item.content, MAX_CONTENT_PARTS);
  if (object(item.action) && item.action.sources !== undefined) boundedArray(item.action.sources, MAX_ACTION_SOURCES);
}
function uniqueObjects(values: unknown[], max: number): unknown[] {
  const seen = new Set<string>();
  const result = values.filter(value => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (result.length > max) throw searchError('WEB_RESPONSE_TOO_LARGE');
  return result;
}
function failed(value: unknown): never {
  const error = object(value) && object(value.error) ? value.error : value;
  if (object(error) && typeof error.code === 'string' && [
    'unsupported_tool', 'unsupported_tools', 'unsupported_model', 'model_not_found',
    'tool_not_supported', 'model_not_supported',
  ].includes(error.code)) throw searchError('WEB_PROVIDER_UNSUPPORTED');
  throw searchError('WEB_RESPONSE_FAILED');
}
export function safeSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f-\u009f]/u.test(value)) return;
  try {
    const url = new URL(value);
    if (!/^https?:\/\//iu.test(value) || /^https?:\/\/[^/?#]*@/iu.test(value) || value.includes('\\')
      || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname) return;
    return value;
  } catch { return; }
}
function cleanText(value: string): string {
  // Each character is searched at most once. A regex restarting at every unmatched
  // opener is quadratic and can block the deadline timer on otherwise small bodies.
  const pieces: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const opening = value.indexOf('\uE200', cursor);
    if (opening < 0) break;
    const closing = value.indexOf('\uE201', opening + 1);
    if (closing < 0) break;
    pieces.push(value.slice(cursor, opening));
    cursor = closing + 1;
  }
  pieces.push(value.slice(cursor));
  // Unmatched marker glyphs disappear, but their ordinary text remains unchanged.
  return pieces.join('').replace(/[\uE200\uE201\uE202]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}
function annotations(part: JsonObject): JsonObject[] {
  return part.annotations === undefined ? [] : boundedArray(part.annotations, MAX_ANNOTATIONS).filter(object);
}

/** Normalize completed native Responses data, never scraping prose links or answer snippets. */
export function normalizeResponsesResponse(value: unknown): NativeSearchResult {
  if (!object(value)) invalid();
  if (value.status === 'failed' || value.error != null) failed(value);
  if (value.status === 'incomplete') throw searchError('WEB_RESPONSE_INCOMPLETE');
  if (value.status !== 'completed') invalid();
  const output = boundedArray(value.output, MAX_OUTPUT_ITEMS);
  const sources: NativeSearchResult['sources'] = [];
  const byUrl = new Map<string, NativeSearchResult['sources'][number]>();
  const addSource = (source: unknown) => {
    if (!object(source)) return;
    const url = safeSourceUrl(source.url);
    if (!url) return;
    const title = typeof source.title === 'string' ? cleanText(source.title).trim() : '';
    // Only explicit source metadata is eligible; generated annotation spans are not snippets.
    const snippet = typeof source.snippet === 'string' ? cleanText(source.snippet).trim() : '';
    const publishedAt = typeof source.publishedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(source.publishedAt)
      && Number.isFinite(Date.parse(source.publishedAt)) ? source.publishedAt : undefined;
    const key = new URL(url).href;
    const existing = byUrl.get(key);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      if (!existing.snippet && snippet) existing.snippet = snippet;
      if (!existing.publishedAt && publishedAt) existing.publishedAt = publishedAt;
    } else {
      const entry = { url, ...(title ? { title } : {}), ...(snippet ? { snippet } : {}), ...(publishedAt ? { publishedAt } : {}) };
      sources.push(entry);
      byUrl.set(key, entry);
    }
  };
  let searched = false;
  const text: string[] = [];
  for (const item of output) {
    if (!object(item)) invalid();
    validateItem(item);
    if (item.type === 'web_search_call') {
      if (item.status === 'failed') throw searchError('WEB_RESPONSE_FAILED');
      if (item.status !== 'completed') throw searchError('WEB_RESPONSE_INCOMPLETE');
      if (!object(item.action) || typeof item.action.type !== 'string') invalid();
      if (item.action.type === 'search') searched = true;
      if (item.action.sources !== undefined) for (const source of boundedArray(item.action.sources, MAX_ACTION_SOURCES)) addSource(source);
    }
    if (item.type === 'message') {
      if (item.status === 'incomplete' || item.status === 'in_progress') throw searchError('WEB_RESPONSE_INCOMPLETE');
      if (!Array.isArray(item.content)) invalid();
      for (const part of boundedArray(item.content, MAX_CONTENT_PARTS)) {
        if (!object(part)) invalid();
        for (const note of annotations(part)) if (note.type === 'url_citation') addSource(note);
        if (part.type === 'output_text') {
          if (typeof part.text !== 'string') invalid();
          // Annotation spans describe generated prose, not source snippets. Preserve them.
          text.push(cleanText(part.text));
        }
      }
    }
  }
  if (!searched) throw searchError('WEB_NO_SEARCH');
  const content = text.join('\n\n').trim();
  return { ...(content ? { content } : {}), sources, truncated: false };
}
function mergePart(old: unknown, next: unknown): JsonObject {
  if (!object(next)) invalid();
  annotations(next);
  if (!object(old)) return { ...next };
  const merged = { ...old, ...next };
  const notes = [...annotations(old), ...annotations(next)];
  if (notes.length) merged.annotations = uniqueObjects(notes, MAX_ANNOTATIONS);
  return merged;
}
function mergeItem(old: JsonObject, next: JsonObject): JsonObject {
  validateItem(next);
  const merged = { ...old, ...next };
  if (object(old.action) && object(next.action)) {
    const action = { ...old.action, ...next.action };
    if (Array.isArray(old.action.sources) || Array.isArray(next.action.sources)) {
      action.sources = uniqueObjects([...(Array.isArray(old.action.sources) ? old.action.sources : []), ...(Array.isArray(next.action.sources) ? next.action.sources : [])], MAX_ACTION_SOURCES);
    }
    merged.action = action;
  }
  if (Array.isArray(old.content) || Array.isArray(next.content)) {
    const content = Array.isArray(old.content) ? [...old.content] : [];
    if (Array.isArray(next.content)) next.content.forEach((part, i) => { content[i] = mergePart(content[i], part); });
    merged.content = content;
  }
  return merged;
}

/** Incremental byte-bounded SSE decoder. [DONE] is not a substitute for completion. */
export class ResponsesSSEParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly items = new Map<number, JsonObject>();
  // Copilot may rewrite IDs on every event. Explicit output_index owns a slot;
  // IDs are bounded routing hints only, and null marks an ambiguous alias.
  private readonly itemIds = new Map<string, number | null>();
  private line = '';
  private frameLines: string[] = [];
  private skipLf = false;
  private bytes = 0;
  private terminal?: JsonObject;
  private done = false;
  private finished = false;
  private readonly maxBytes: number;
  constructor(options: { maxResponseBytes?: number } = {}) {
    this.maxBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) throw searchError('WEB_INVALID_CONFIG');
  }
  push(chunk: Uint8Array): void {
    if (this.finished) invalid();
    this.bytes += chunk.byteLength;
    if (this.bytes > this.maxBytes) throw searchError('WEB_RESPONSE_TOO_LARGE');
    let text: string;
    try { text = this.decoder.decode(chunk, { stream: true }); } catch { invalid(); }
    this.consume(text, false);
  }
  private consume(text: string, final: boolean): void {
    let start = 0;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (this.skipLf) {
        this.skipLf = false;
        if (character === '\n') { start = index + 1; continue; }
      }
      if (character !== '\r' && character !== '\n') continue;
      this.line += text.slice(start, index);
      if (this.line) {
        if (this.frameLines.length >= 4096) throw searchError('WEB_RESPONSE_TOO_LARGE');
        this.frameLines.push(this.line);
      } else if (this.frameLines.length) {
        this.frame(this.frameLines.join('\n'));
        this.frameLines = [];
      }
      this.line = '';
      this.skipLf = character === '\r';
      start = index + 1;
    }
    this.line += text.slice(start);
    if (final) {
      if (this.line) {
        if (this.frameLines.length >= 4096) throw searchError('WEB_RESPONSE_TOO_LARGE');
        this.frameLines.push(this.line);
      }
      this.line = '';
      if (this.frameLines.length) this.frame(this.frameLines.join('\n'));
      this.frameLines = [];
    }
  }
  private frame(frame: string): void {
    const data: string[] = [];
    let eventName: string | undefined;
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      if (field === 'event') eventName = value;
    }
    if (!data.length) return;
    const payload = data.join('\n');
    if (payload.trim() === '[DONE]') { this.done = true; return; }
    if (this.done) invalid();
    let event: unknown;
    try { event = JSON.parse(payload); } catch { invalid(); }
    if (!object(event)) invalid();
    const type = typeof event.type === 'string' ? event.type : eventName;
    if (type === 'error' || type === 'response.failed') failed(object(event.response) ? event.response : event);
    if (type === 'response.incomplete') throw searchError('WEB_RESPONSE_INCOMPLETE');
    if (type === 'response.completed') {
      if (this.terminal || !object(event.response) || event.response.status !== 'completed') invalid();
      this.terminal = event.response;
      if (event.response.output !== undefined) boundedArray(event.response.output, MAX_OUTPUT_ITEMS).forEach((item, index) => this.addItem(index, item));
      return;
    }
    if (this.terminal) return;
    if (type === 'response.output_item.done' || type === 'response.output_item.added') {
      this.addItem(this.index(event), event.item);
    } else if (type === 'response.content_part.done' || type === 'response.content_part.added') {
      const index = this.index(event);
      const item = this.items.get(index) ?? { type: 'message' };
      const content = Array.isArray(item.content) ? [...item.content] : [];
      const partIndex = this.contentIndex(event);
      content[partIndex] = mergePart(content[partIndex], event.part);
      this.items.set(index, { ...item, content });
    } else if (type === 'response.output_text.annotation.added') {
      if (!object(event.annotation)) invalid();
      const index = this.index(event);
      const item = this.items.get(index) ?? { type: 'message' };
      const content = Array.isArray(item.content) ? [...item.content] : [];
      const partIndex = this.contentIndex(event);
      const part = object(content[partIndex]) ? content[partIndex] : { type: 'output_text' };
      content[partIndex] = mergePart(part, { annotations: [event.annotation] });
      this.items.set(index, { ...item, content });
    }
  }
  private rememberId(value: unknown, index: number): void {
    if (typeof value !== 'string') return;
    if (!this.itemIds.has(value) && this.itemIds.size >= MAX_ITEM_ID_ALIASES) throw searchError('WEB_RESPONSE_TOO_LARGE');
    const previous = this.itemIds.get(value);
    this.itemIds.set(value, previous === undefined || previous === index ? index : null);
  }
  private index(event: JsonObject): number {
    if (event.output_index !== undefined) {
      if (typeof event.output_index !== 'number' || !Number.isSafeInteger(event.output_index) || event.output_index < 0) return invalid();
      if (event.output_index >= MAX_OUTPUT_ITEMS) throw searchError('WEB_RESPONSE_TOO_LARGE');
      this.rememberId(event.item_id, event.output_index);
      return event.output_index;
    }
    if (typeof event.item_id === 'string') {
      const index = this.itemIds.get(event.item_id);
      if (typeof index === 'number') return index;
    }
    return invalid();
  }
  private contentIndex(event: JsonObject): number {
    if (typeof event.content_index !== 'number' || !Number.isSafeInteger(event.content_index) || event.content_index < 0) invalid();
    if (event.content_index >= MAX_CONTENT_PARTS) throw searchError('WEB_RESPONSE_TOO_LARGE');
    return event.content_index;
  }
  private addItem(index: number, item: unknown): void {
    if (!object(item)) invalid();
    const previous = this.items.get(index);
    if (item.type !== undefined && typeof item.type !== 'string') invalid();
    if (previous?.type !== undefined && item.type !== undefined && previous.type !== item.type) invalid();
    this.rememberId(item.id, index);
    this.items.set(index, mergeItem(previous ?? {}, item));
  }
  finish(): NativeSearchResult {
    if (this.finished) invalid();
    this.finished = true;
    let tail: string;
    try { tail = this.decoder.decode(); } catch { invalid(); }
    this.consume(tail, true);
    if (!this.terminal) throw searchError('WEB_STREAM_INCOMPLETE');
    const output = [...this.items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    return normalizeResponsesResponse({ ...this.terminal, output });
  }
}
export function parseResponsesSSE(value: string | Uint8Array, options: { maxResponseBytes?: number } = {}): NativeSearchResult {
  const parser = new ResponsesSSEParser(options);
  parser.push(typeof value === 'string' ? new TextEncoder().encode(value) : value);
  return parser.finish();
}
export function parseResponsesJSON(bytes: Uint8Array, maxResponseBytes: number): NativeSearchResult {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw searchError('WEB_INVALID_CONFIG');
  if (bytes.byteLength > maxResponseBytes) throw searchError('WEB_RESPONSE_TOO_LARGE');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { invalid(); }
  return normalizeResponsesResponse(value);
}
