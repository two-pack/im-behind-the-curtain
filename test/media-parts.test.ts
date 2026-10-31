import { describe, expect, it } from "vitest";
import { isSavedFileName, readDataUrl, savedFileName } from "../src/media-parts.js";

function readable(url: string): { mediaType: string | null; bytes: number[] } {
  const result = readDataUrl(url);
  if (result === undefined) {
    throw new Error(`expected the data URL to be readable: ${url}`);
  }
  return { mediaType: result.mediaType, bytes: [...result.bytes] };
}

describe("reading the structure of a data URL", () => {
  it("reads the media type and the bytes of a base64 data URL", () => {
    expect(readable("data:image/png;base64,QUJD")).toEqual({
      mediaType: "image/png",
      bytes: [65, 66, 67],
    });
  });

  it("does not care about the case of data: and ;base64", () => {
    expect(readable("DATA:image/png;BASE64,QUJD").bytes).toEqual([65, 66, 67]);
    expect(readable("Data:image/png;Base64,QUJD").bytes).toEqual([65, 66, 67]);
  });

  it("cannot read a URL that does not start with data:", () => {
    for (const url of ["https://example.com/a.png", "", "dat:image/png;base64,QUJD", " data:x"]) {
      expect(readDataUrl(url), url).toBeUndefined();
    }
  });

  it("cannot read a data URL without a comma", () => {
    expect(readDataUrl("data:image/png;base64")).toBeUndefined();
  });

  it("cannot read a data URL whose head does not end with ;base64", () => {
    for (const url of [
      "data:image/png,QUJD",
      "data:image/png;charset=utf-8,QUJD",
      "data:base64,QUJD",
      "data:image/png;base64;name=a.png,QUJD",
    ]) {
      expect(readDataUrl(url), url).toBeUndefined();
    }
  });

  it("splits the head at the first comma only", () => {
    expect(readDataUrl("data:image/png;base64,QUJD,QUJD")).toBeUndefined();
  });
});

describe("reading the base64 data", () => {
  it("reads empty data as zero bytes", () => {
    expect(readable("data:image/png;base64,")).toEqual({ mediaType: "image/png", bytes: [] });
  });

  it("reads data with one or two = of padding", () => {
    expect(readable("data:x/y;base64,QUI=").bytes).toEqual([65, 66]);
    expect(readable("data:x/y;base64,QQ==").bytes).toEqual([65]);
  });

  it("reads data without padding when the length leaves a remainder of 2 or 3", () => {
    expect(readable("data:x/y;base64,QQ").bytes).toEqual([65]);
    expect(readable("data:x/y;base64,QUI").bytes).toEqual([65, 66]);
  });

  it("reads the + and / characters", () => {
    expect(readable("data:x/y;base64,+/8=").bytes).toEqual([251, 255]);
  });

  it("cannot read data with a remainder of 1, or padding that does not fit the length", () => {
    for (const data of ["Q", "QUJDQ", "QQ=", "QUJ==", "Q===", "QQ===", "QUI=Q"]) {
      expect(readDataUrl(`data:x/y;base64,${data}`), data).toBeUndefined();
    }
  });

  it("cannot read data with spaces, new lines or the URL-safe alphabet", () => {
    for (const data of ["QU JD", "QUJD\n", "QU-D", "QU_D", "QUJD ", "QUJ*"]) {
      expect(readDataUrl(`data:x/y;base64,${data}`), data).toBeUndefined();
    }
  });

  it("reads a body of several megabytes", () => {
    const data = Buffer.alloc(3_000_000, 7).toString("base64");
    expect(readDataUrl(`data:x/y;base64,${data}`)?.bytes.length).toBe(3_000_000);
  });
});

describe("the media type of a data URL", () => {
  it("lowercases the media type", () => {
    expect(readable("data:IMAGE/PNG;base64,QUJD").mediaType).toBe("image/png");
  });

  it("leaves a name= or other addition out of the media type", () => {
    expect(readable("data:image/png;name=a.png;base64,QUJD").mediaType).toBe("image/png");
    expect(readable("data:image/svg+xml;charset=utf-8;base64,QUJD").mediaType).toBe(
      "image/svg+xml",
    );
  });

  it("is unknown, not unreadable, when the media type is missing", () => {
    expect(readable("data:;base64,QUJD").mediaType).toBeNull();
    expect(readable("data:;name=a;base64,QUJD").mediaType).toBeNull();
  });

  it("is unknown when the media type is not of the form type/subtype", () => {
    for (const type of [
      "png",
      "image/",
      "/png",
      "image/png/x",
      "image png",
      "image/p\u001bng",
      "-a/b",
    ]) {
      expect(readable(`data:${type};base64,QUJD`).mediaType, type).toBeNull();
    }
  });

  it("keeps a media type that is not an image", () => {
    expect(readable("data:text/plain;base64,QUJD").mediaType).toBe("text/plain");
  });

  it("is unknown when a part of the media type is longer than 127 characters", () => {
    const ok = "a".repeat(127);
    const long = "a".repeat(128);
    expect(readable(`data:${ok}/${ok};base64,QUJD`).mediaType).toBe(`${ok}/${ok}`);
    expect(readable(`data:${long}/b;base64,QUJD`).mediaType).toBeNull();
    expect(readable(`data:b/${long};base64,QUJD`).mediaType).toBeNull();
  });
});

describe("the name of a saved file", () => {
  it("is message-<m>-part-<p>.<extension>", () => {
    expect(savedFileName(1, 2, "image/png")).toBe("message-1-part-2.png");
    expect(savedFileName(12, 345, "image/png")).toBe("message-12-part-345.png");
  });

  it("takes the extension from a fixed table", () => {
    const table: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/bmp": "bmp",
      "image/svg+xml": "svg",
    };
    for (const [mediaType, extension] of Object.entries(table)) {
      expect(savedFileName(1, 1, mediaType), mediaType).toBe(`message-1-part-1.${extension}`);
    }
  });

  it("uses .bin for a media type that is not in the table, and for an unknown one", () => {
    expect(savedFileName(1, 1, "text/plain")).toBe("message-1-part-1.bin");
    expect(savedFileName(1, 1, "image/x-unknown")).toBe("message-1-part-1.bin");
    expect(savedFileName(1, 1, null)).toBe("message-1-part-1.bin");
  });

  it("does not use a name that is a property of Object", () => {
    expect(savedFileName(1, 1, "constructor")).toBe("message-1-part-1.bin");
    expect(savedFileName(1, 1, "__proto__")).toBe("message-1-part-1.bin");
  });

  it("depends only on the numbers and the media type, so equal parts get different names", () => {
    expect(savedFileName(1, 1, "image/png")).toBe(savedFileName(1, 1, "image/png"));
    expect(savedFileName(1, 1, "image/png")).not.toBe(savedFileName(1, 2, "image/png"));
    expect(savedFileName(1, 1, "image/png")).not.toBe(savedFileName(2, 1, "image/png"));
  });
});

describe("telling a saved file name by its form", () => {
  it("accepts a name that savedFileName makes", () => {
    for (const mediaType of ["image/png", "image/jpeg", "text/plain", null]) {
      expect(isSavedFileName(savedFileName(3, 14, mediaType)), String(mediaType)).toBe(true);
    }
  });

  it("looks at the form only, not at the extension table", () => {
    expect(isSavedFileName("message-1-part-1.xyz")).toBe(true);
    expect(isSavedFileName("message-1-part-1.mp3")).toBe(true);
    expect(isSavedFileName("message-1-part-1.7z")).toBe(true);
  });

  it("rejects a name with a path separator or with ..", () => {
    for (const name of [
      "../message-1-part-1.png",
      "message-1-part-1.png/",
      "a/message-1-part-1.png",
      "a\\message-1-part-1.png",
      "message-1-part-1..png",
      "message-1-part-1.png.",
      "..",
      ".",
    ]) {
      expect(isSavedFileName(name), name).toBe(false);
    }
  });

  it("rejects a name that is not of the form", () => {
    for (const name of [
      "",
      "request.json",
      "state.json",
      "message-0-part-1.png",
      "message-1-part-0.png",
      "message--part-1.png",
      "message-1-part-.png",
      "message-1-part-1",
      "message-1-part-1.",
      "message-1.5-part-1.png",
      "message-01-part-1.png",
      "message-1-part-1.PNG",
      "Message-1-part-1.png",
      "message-1-part-1.png ",
      " message-1-part-1.png",
      "message-1-part-1.png\n",
      "message-1-part-1.p-g",
    ]) {
      expect(isSavedFileName(name), JSON.stringify(name)).toBe(false);
    }
  });
});
