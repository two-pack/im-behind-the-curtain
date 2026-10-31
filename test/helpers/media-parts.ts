import net from "node:net";

/** "RIFF" as base64: four bytes of an audio file. */
export const WAV_BASE64 = "UklGRg==";

/** "%PDF-1.4" as base64: eight bytes of a file. */
export const PDF_BASE64 = "JVBERi0xLjQ=";

export const FILE_ID = "file-abc123";

/** A listener on 127.0.0.1 that counts the connections it gets. It never answers. */
export interface ConnectionCounter {
  /** The address of the listener, which a part can use as the address of an image. */
  address: string;
  connections: () => number;
  close: () => Promise<void>;
}

export async function listenForConnections(): Promise<ConnectionCounter> {
  let count = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    address: `http://127.0.0.1:${port}/cat.png`,
    connections: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close(() => resolve());
      }),
  };
}

/**
 * The parts of one message that cover every kind this server takes: text, audio, a file with
 * data, an image by address, a file by id, a file whose data is empty, an audio part without data
 * and a part of an unknown type. Only the audio and the file with data are saved.
 */
export function everyKindOfPart(address: string): Record<string, unknown>[] {
  return [
    { type: "text", text: "listen" },
    { type: "input_audio", input_audio: { data: WAV_BASE64, format: "wav" } },
    {
      type: "file",
      file: {
        file_data: `data:application/pdf;base64,${PDF_BASE64}`,
        filename: "report.pdf",
      },
    },
    { type: "image_url", image_url: { url: address } },
    { type: "file", file: { file_id: FILE_ID } },
    { type: "file", file: { file_data: "", file_id: FILE_ID } },
    { type: "input_audio" },
    { type: "video_url", video_url: { url: "https://example.com/v.mp4" } },
  ];
}
