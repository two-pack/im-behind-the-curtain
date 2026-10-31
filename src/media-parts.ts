/**
 * Reads the parts of a message that are not text, and names the files they are saved as. This is a
 * leaf module: it has no side effects and calls no other module.
 */

/** What a readable data URL holds. `mediaType` is null when the header gives no valid one. */
export interface DataUrlContent {
  mediaType: string | null;
  bytes: Uint8Array;
}

const DATA_PREFIX = "data:";
const BASE64_MARK = ";base64";

/** The most characters of the type and of the subtype of a media type. */
const MAX_MEDIA_NAME = 127;

const MEDIA_NAME = `[a-z0-9][a-z0-9!#$&^_.+-]{0,${MAX_MEDIA_NAME - 1}}`;
const MEDIA_TYPE = new RegExp(`^${MEDIA_NAME}/${MEDIA_NAME}$`);

/** The standard alphabet, with zero to two `=` at the end. */
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;

/** The extension of each media type that has one. Every other type gets `.bin`. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

const UNKNOWN_EXTENSION = "bin";

/** The form of a name that this server gives to a saved part. The extension is not looked up. */
const SAVED_FILE_NAME = /^message-[1-9][0-9]*-part-[1-9][0-9]*\.[a-z0-9]+$/;

/** Whether `data` has the standard characters and a length that base64 can have. */
function isBase64(data: string): boolean {
  if (!BASE64_TEXT.test(data)) {
    return false;
  }
  return data.endsWith("=") ? data.length % 4 === 0 : data.length % 4 !== 1;
}

/** The media type of a header: its first item in lower case, or null if it is not type/subtype. */
function mediaTypeOf(header: string): string | null {
  const first = (header.split(";", 1)[0] ?? "").toLowerCase();
  return MEDIA_TYPE.test(first) ? first : null;
}

/**
 * Reads a `data:` URL that has a `;base64` mark. Undefined means the URL cannot be read: it does
 * not start with `data:`, has no comma, does not end its header with `;base64`, or its data is not
 * base64. A media type that is not valid is null, which is not a failure.
 */
export function readDataUrl(url: string): DataUrlContent | undefined {
  if (url.slice(0, DATA_PREFIX.length).toLowerCase() !== DATA_PREFIX) {
    return undefined;
  }
  const rest = url.slice(DATA_PREFIX.length);
  const comma = rest.indexOf(",");
  if (comma < 0) {
    return undefined;
  }
  const header = rest.slice(0, comma);
  const data = rest.slice(comma + 1);
  if (!header.toLowerCase().endsWith(BASE64_MARK) || !isBase64(data)) {
    return undefined;
  }
  return { mediaType: mediaTypeOf(header), bytes: new Uint8Array(Buffer.from(data, "base64")) };
}

/**
 * The name of the file a part is saved as: `message-<m>-part-<p>.<extension>`. The numbers count
 * from 1. Only the numbers and the media type decide the name; nothing the client sent is used.
 */
export function savedFileName(
  messageNumber: number,
  partNumber: number,
  mediaType: string | null,
): string {
  const known = mediaType !== null && Object.hasOwn(EXTENSIONS, mediaType);
  const extension = known ? EXTENSIONS[mediaType] : UNKNOWN_EXTENSION;
  return `message-${messageNumber}-part-${partNumber}.${extension}`;
}

/** Whether `name` has the form of a name that `savedFileName` makes. It checks the form only. */
export function isSavedFileName(name: string): boolean {
  return SAVED_FILE_NAME.test(name);
}
