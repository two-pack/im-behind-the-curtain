import {
  type AudioFormat,
  createReplyFile,
  type ReplyAudio,
  serializeFile,
} from "../../src/model.js";

/** The leading bytes that identify each format. The rest is not real audio, and need not be. */
const SIGNATURES: Readonly<Record<AudioFormat, readonly number[]>> = {
  wav: [...Buffer.from("RIFF"), 0x24, 0, 0, 0, ...Buffer.from("WAVE")],
  mp3: [...Buffer.from("ID3"), 0x04, 0],
  flac: [...Buffer.from("fLaC")],
  opus: [...Buffer.from("OggS")],
  pcm16: [0, 0],
};

/** Bytes that pass the check of the leading bytes of `format`, followed by `tail` more bytes. */
export function audioBytes(format: AudioFormat, tail = 4): Uint8Array {
  const bytes = new Uint8Array(SIGNATURES[format].length + tail);
  bytes.set(SIGNATURES[format]);
  for (let index = SIGNATURES[format].length; index < bytes.length; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

/** The audio of a reply file made from `audioBytes`. */
export function replyAudio(format: AudioFormat, tail = 4): ReplyAudio {
  return { format, data: Buffer.from(audioBytes(format, tail)).toString("base64") };
}

/** A reply audio whose decoded data is exactly `size` bytes and passes the check of its format. */
export function replyAudioOfSize(format: AudioFormat, size: number): ReplyAudio {
  const head = audioBytes(format, 0).length;
  return replyAudio(format, size - head);
}

/**
 * The sizes of a wav, in decoded bytes, whose reply file (with no transcript) is the largest that
 * is still within `limit` bytes as written (`fits`), and one byte more (`over`, which base64
 * turns into four more bytes in the file). The size of a file is a fixed part and four
 * characters for each three bytes of audio, so this is worked out, not tried.
 */
export function audioSizesAtLimit(limit: number): { fits: number; over: number } {
  const probe = serializeFile(
    createReplyFile("", "2026-10-09T14:05:12.123Z", "audio", replyAudio("wav", 0)),
  );
  const fixed = Buffer.byteLength(probe) - replyAudio("wav", 0).data.length;
  const fits = Math.floor((limit - fixed) / 4) * 3;
  return { fits, over: fits + 1 };
}
