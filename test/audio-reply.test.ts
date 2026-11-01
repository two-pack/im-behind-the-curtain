import { describe, expect, it } from "vitest";
import {
  type AudioRules,
  audioRequestOf,
  checkAudioRules,
  formatOfPath,
  matchesFormat,
  NO_AUDIO_REQUEST,
  readFileMarker,
} from "../src/audio-reply.js";
import { AUDIO_FORMATS } from "../src/model.js";
import { audioBytes } from "./helpers/audio.js";

describe("reading the @file line of a typed reply (FR15.1, FR15.2)", () => {
  it("takes a reply without a marker line as text", () => {
    expect(readFileMarker("Hello\nworld")).toEqual({ kind: "text" });
  });

  it("takes the path from the marker line and the other lines as the transcript", () => {
    expect(readFileMarker("Hello\n@file voice.wav\nworld")).toEqual({
      kind: "file",
      path: "voice.wav",
      transcript: "Hello\nworld",
    });
  });

  it("gives an empty transcript when the marker line is the only line", () => {
    expect(readFileMarker("@file voice.wav")).toEqual({
      kind: "file",
      path: "voice.wav",
      transcript: "",
    });
  });

  it("trims the white space around the path and keeps spaces and quotes inside it", () => {
    expect(readFileMarker('@file    "my voice.wav" \t ')).toEqual({
      kind: "file",
      path: '"my voice.wav"',
      transcript: "",
    });
  });

  it("does not take @filename, an indented marker, or a tab after the word as a marker", () => {
    for (const text of ["@filename voice.wav", " @file voice.wav", "@file\tvoice.wav", "@file"]) {
      expect(readFileMarker(text)).toEqual({ kind: "text" });
    }
  });

  it("refuses a marker line without a path", () => {
    expect(readFileMarker("@file ")).toEqual({ kind: "refused", reason: "emptyPath" });
    expect(readFileMarker("Hi\n@file    \t")).toEqual({ kind: "refused", reason: "emptyPath" });
  });

  it("refuses two or more marker lines, even when one has no path", () => {
    expect(readFileMarker("@file a.wav\n@file b.wav")).toEqual({
      kind: "refused",
      reason: "manyMarkers",
    });
    expect(readFileMarker("@file a.wav\nHi\n@file ")).toEqual({
      kind: "refused",
      reason: "manyMarkers",
    });
  });

  it("reads the same with CRLF and CR line ends", () => {
    for (const lineEnd of ["\r\n", "\r"]) {
      expect(readFileMarker(`Hello${lineEnd}@file a.mp3${lineEnd}world`)).toEqual({
        kind: "file",
        path: "a.mp3",
        transcript: "Hello\nworld",
      });
    }
  });
});

describe("the audio format of a path (FR15.4, FR15.5)", () => {
  it("maps each extension of the table to its format", () => {
    const table: Record<string, string> = {
      "a.wav": "wav",
      "a.mp3": "mp3",
      "a.flac": "flac",
      "a.opus": "opus",
      "a.pcm": "pcm16",
    };
    for (const [path, format] of Object.entries(table)) {
      expect(formatOfPath(path)).toEqual({ kind: "ok", format });
    }
  });

  it("does not depend on the case of the extension or on the kind of path separator", () => {
    expect(formatOfPath("/home/alice/My.Voice.WAV")).toEqual({ kind: "ok", format: "wav" });
    expect(formatOfPath("C:\\music\\clip.Mp3")).toEqual({ kind: "ok", format: "mp3" });
  });

  it("refuses an image with the reason that an image cannot be returned", () => {
    for (const name of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.bmp", "a.svg", "A.PNG"]) {
      expect(formatOfPath(name)).toEqual({ kind: "refused", reason: "image" });
    }
  });

  it("refuses aac, an unknown extension, no extension, and a dot only in a folder name", () => {
    for (const path of ["a.aac", "a.txt", "voice", "/music.d/voice", "a.", ".wav"]) {
      expect(formatOfPath(path)).toEqual({ kind: "refused", reason: "unknownExtension" });
    }
  });
});

describe("the leading bytes of each format (FR15.6)", () => {
  it("accepts the signature of each format", () => {
    for (const format of AUDIO_FORMATS) {
      expect(matchesFormat(format, audioBytes(format))).toBe(true);
    }
  });

  it("accepts both kinds of mp3: ID3, and a frame sync with the top 3 bits set", () => {
    expect(matchesFormat("mp3", Uint8Array.of(0x49, 0x44, 0x33))).toBe(true);
    expect(matchesFormat("mp3", Uint8Array.of(0xff, 0xfb, 0x90))).toBe(true);
    expect(matchesFormat("mp3", Uint8Array.of(0xff, 0xe0, 0x00))).toBe(true);
    expect(matchesFormat("mp3", Uint8Array.of(0xff, 0x1b, 0x90))).toBe(false);
    expect(matchesFormat("mp3", Uint8Array.of(0x00, 0xfb, 0x90))).toBe(false);
  });

  it("requires WAVE at byte 8 of a wav, not only RIFF", () => {
    const riffOnly = new TextEncoder().encode("RIFF\0\0\0\0AVI LIST");
    expect(matchesFormat("wav", riffOnly)).toBe(false);
  });

  it("treats a file shorter than its signature as not matching", () => {
    expect(matchesFormat("wav", audioBytes("wav").subarray(0, 11))).toBe(false);
    expect(matchesFormat("mp3", Uint8Array.of(0xff, 0xfb))).toBe(false);
    expect(matchesFormat("flac", audioBytes("flac").subarray(0, 3))).toBe(false);
    expect(matchesFormat("opus", audioBytes("opus").subarray(0, 3))).toBe(false);
    expect(matchesFormat("wav", new Uint8Array())).toBe(false);
  });

  it("does not take the signature of one format for another", () => {
    expect(matchesFormat("flac", audioBytes("wav"))).toBe(false);
    expect(matchesFormat("opus", audioBytes("flac"))).toBe(false);
    expect(matchesFormat("wav", audioBytes("mp3"))).toBe(false);
  });

  it("checks pcm16 only for an even length", () => {
    expect(matchesFormat("pcm16", Uint8Array.of(1, 2, 3, 4))).toBe(true);
    expect(matchesFormat("pcm16", Uint8Array.of(1, 2, 3))).toBe(false);
  });
});

describe("what a request says about audio (FR15.3, FR15.7)", () => {
  it("asks for audio when modalities is an array that holds the string audio", () => {
    expect(audioRequestOf({ modalities: ["text", "audio"] }).asked).toBe(true);
    expect(audioRequestOf({ modalities: ["audio"] }).asked).toBe(true);
  });

  it("does not ask for audio otherwise", () => {
    for (const modalities of [undefined, "audio", ["text"], [], ["Audio"], { 0: "audio" }, null]) {
      expect(audioRequestOf({ modalities }).asked).toBe(false);
    }
  });

  it("reads audio.format only when it is a string", () => {
    expect(audioRequestOf({ audio: { voice: "alloy", format: "mp3" } }).format).toBe("mp3");
    for (const audio of [undefined, null, "mp3", [], { format: 5 }, { voice: "alloy" }]) {
      expect(audioRequestOf({ audio }).format).toBeUndefined();
    }
  });

  it("is the same value for a request without either field", () => {
    expect(audioRequestOf({ model: "x" })).toEqual(NO_AUDIO_REQUEST);
  });
});

describe("what a request must allow for an audio reply (FR15.3, FR15.7, FR15.9, FR15.10)", () => {
  const ASKING: AudioRules = {
    replyKind: "text",
    toolDefinitions: "none",
    audio: { asked: true, format: "wav" },
  };
  const CALLS = JSON.stringify([
    { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
  ]);

  it("allows a reply of the format that was asked for", () => {
    expect(checkAudioRules(ASKING, "wav", "Hello")).toBeUndefined();
  });

  it("allows any format when the request names none", () => {
    const rules = { ...ASKING, audio: { asked: true, format: undefined } };
    expect(checkAudioRules(rules, "flac", "")).toBeUndefined();
  });

  it("refuses when the request did not ask for audio", () => {
    expect(checkAudioRules({ ...ASKING, audio: NO_AUDIO_REQUEST }, "wav", "")).toBe("notAsked");
  });

  it("refuses a format that differs from audio.format", () => {
    expect(checkAudioRules(ASKING, "mp3", "")).toBe("formatDiffers");
  });

  it("refuses a request for structured output", () => {
    expect(checkAudioRules({ ...ASKING, replyKind: "json" }, "wav", "")).toBe("structured");
  });

  it("refuses a transcript that is tool calls, for a request that defines tools", () => {
    expect(checkAudioRules({ ...ASKING, toolDefinitions: "tools" }, "wav", CALLS)).toBe(
      "toolCalls",
    );
  });

  it("refuses a transcript that is a function call, and one that is calls that do not fit", () => {
    expect(checkAudioRules({ ...ASKING, toolDefinitions: "functions" }, "wav", CALLS)).toBe(
      "toolCalls",
    );
    const broken = JSON.stringify([{ function: {} }]);
    expect(checkAudioRules({ ...ASKING, toolDefinitions: "tools" }, "wav", broken)).toBe(
      "toolCalls",
    );
  });

  it("takes the same text as a transcript when the request defines no tools", () => {
    expect(checkAudioRules(ASKING, "wav", CALLS)).toBeUndefined();
  });

  it("reports the first problem in the order: not asked, format, structured, tool calls", () => {
    const all: AudioRules = {
      replyKind: "json",
      toolDefinitions: "tools",
      audio: { asked: true, format: "wav" },
    };
    expect(checkAudioRules({ ...all, audio: NO_AUDIO_REQUEST }, "mp3", CALLS)).toBe("notAsked");
    expect(checkAudioRules(all, "mp3", CALLS)).toBe("formatDiffers");
    expect(checkAudioRules(all, "wav", CALLS)).toBe("structured");
  });
});
