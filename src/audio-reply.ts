/**
 * The rules of an audio reply, in one place: the `@file` line of a typed reply, the audio format
 * a file name stands for, the leading bytes of each format, and what a request must allow for an
 * audio reply. The answer screen, the reply from standard input and the check of a reply file all
 * call these functions, so they cannot disagree. This is a leaf module: it has no side effects
 * and reads no file. A reason is a short key; the sentences are made where they are shown, and
 * never carry a character of a file.
 */
import type { AudioFormat, ReplyKind, ToolDefinitions } from "./model.js";
import { classifyReply } from "./tool-calls.js";

/** What reading a typed reply for an `@file` line found. */
export type MarkerReading =
  /** No line starts with `@file `: the reply is text. */
  | { kind: "text" }
  /** One marker line: the path, and the rest of the text. */
  | { kind: "file"; path: string; transcript: string }
  | { kind: "refused"; reason: "emptyPath" | "manyMarkers" };

/** The audio format a path stands for, or why it stands for none. */
export type FormatChoice =
  | { kind: "ok"; format: AudioFormat }
  | { kind: "refused"; reason: "image" | "unknownExtension" };

/** What a request says about audio, read from the body as received. */
export interface AudioRequest {
  /** `modalities` is an array that holds the string `audio`. */
  asked: boolean;
  /** `audio.format` when it is a string. */
  format: string | undefined;
}

/** Everything about a request that decides whether an audio reply may be sent. */
export interface AudioRules {
  replyKind: ReplyKind;
  toolDefinitions: ToolDefinitions;
  audio: AudioRequest;
}

/** Why a request does not allow an audio reply, in the order the checks are made. */
export type RuleProblem = "notAsked" | "formatDiffers" | "structured" | "toolCalls";

/** The audio part of a request that asks for none. */
export const NO_AUDIO_REQUEST: AudioRequest = { asked: false, format: undefined };

/** A line is a marker line when it starts with these six characters: `@file` and one space. */
const MARKER = "@file ";

const LINE_END = /\r\n|\r|\n/;

/** The audio format of each extension, in lower case. */
const AUDIO_EXTENSIONS: Readonly<Record<string, AudioFormat>> = {
  wav: "wav",
  mp3: "mp3",
  flac: "flac",
  opus: "opus",
  pcm: "pcm16",
};

/** The extensions of images, which Chat Completions has no way to return. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
]);

/** The fewest leading bytes that identify each format. A shorter file does not match. */
const SIGNATURE_BYTES: Readonly<Record<AudioFormat, number>> = {
  wav: 12,
  mp3: 3,
  flac: 4,
  opus: 4,
  pcm16: 0,
};

const encoder = new TextEncoder();

/**
 * Looks for the marker line in a typed reply. A line starting with `@file` and one space is the
 * marker line, and the rest of it, trimmed, is the path, with no quotes read. The other lines,
 * joined with line feeds, are the transcript. More than one marker line, or a path that is empty,
 * is refused. A reply without a marker line is text, even when a line starts with `@file` and
 * something other than a space.
 */
export function readFileMarker(text: string): MarkerReading {
  const lines = text.split(LINE_END);
  const markers = lines.filter((line) => line.startsWith(MARKER));
  if (markers.length === 0) {
    return { kind: "text" };
  }
  if (markers.length > 1) {
    return { kind: "refused", reason: "manyMarkers" };
  }
  const path = (markers[0] ?? "").slice(MARKER.length).trim();
  if (path === "") {
    return { kind: "refused", reason: "emptyPath" };
  }
  const transcript = lines.filter((line) => !line.startsWith(MARKER)).join("\n");
  return { kind: "file", path, transcript };
}

/** The extension of the last part of a path, in lower case, or "" when it has none. */
function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * The audio format that the extension of a path stands for. The path is read as text, so a
 * slash and a backslash both end a folder name, on any system. An image is refused with its own
 * reason, and so is any extension that is not in the table, `aac` among them.
 */
export function formatOfPath(path: string): FormatChoice {
  const extension = extensionOf(path);
  if (Object.hasOwn(AUDIO_EXTENSIONS, extension)) {
    return { kind: "ok", format: AUDIO_EXTENSIONS[extension] as AudioFormat };
  }
  return {
    kind: "refused",
    reason: IMAGE_EXTENSIONS.has(extension) ? "image" : "unknownExtension",
  };
}

function startsWith(bytes: Uint8Array, text: string, offset = 0): boolean {
  const expected = encoder.encode(text);
  return expected.every((value, index) => bytes[offset + index] === value);
}

/** An mp3 starts with ID3, or with a frame sync: 0xFF and a byte whose top 3 bits are set. */
function isMp3(bytes: Uint8Array): boolean {
  return startsWith(bytes, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);
}

/**
 * Whether the leading bytes fit the format. wav is RIFF and, from byte 8, WAVE; flac is fLaC; opus
 * is OggS (the container only, not what is in it); mp3 is ID3 or a frame sync. pcm16 has no mark,
 * so only an even length is checked. A file shorter than the bytes a mark needs does not match.
 */
export function matchesFormat(format: AudioFormat, bytes: Uint8Array): boolean {
  if (bytes.length < SIGNATURE_BYTES[format]) {
    return false;
  }
  switch (format) {
    case "wav":
      return startsWith(bytes, "RIFF") && startsWith(bytes, "WAVE", 8);
    case "mp3":
      return isMp3(bytes);
    case "flac":
      return startsWith(bytes, "fLaC");
    case "opus":
      return startsWith(bytes, "OggS");
    default:
      return bytes.length % 2 === 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the body of a request, as received, says about audio: `modalities` and `audio.format`. */
export function audioRequestOf(original: Record<string, unknown>): AudioRequest {
  const { modalities, audio } = original;
  const format = isRecord(audio) && typeof audio.format === "string" ? audio.format : undefined;
  return { asked: Array.isArray(modalities) && modalities.includes("audio"), format };
}

/**
 * What stops an audio reply of `format` with this transcript, given what the request is, or
 * nothing when it may be sent. The checks go in order: the request asks for audio, its
 * `audio.format` (when it names one) is the format, it does not ask for structured output, and the
 * transcript is not tool calls.
 */
export function checkAudioRules(
  rules: AudioRules,
  format: AudioFormat,
  transcript: string,
): RuleProblem | undefined {
  if (!rules.audio.asked) {
    return "notAsked";
  }
  if (rules.audio.format !== undefined && rules.audio.format !== format) {
    return "formatDiffers";
  }
  if (rules.replyKind === "json") {
    return "structured";
  }
  return classifyReply(transcript, rules.toolDefinitions).kind === "text" ? undefined : "toolCalls";
}
